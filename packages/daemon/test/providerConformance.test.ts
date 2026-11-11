import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AcpAgentHost,
  AncillaStore,
  ClaudeCliStreamHost,
  CodexAppServerHost,
  SessionManager,
  UnsupportedCapabilityError,
  planProviderCli,
  planProviderServe,
  probeProviderBinary,
  type MspNotification,
} from "../src/index.js";
import { createFakeAcpSpawn } from "./fakes/fakeAcpAgent.js";
import { createFakeClaudeSpawn } from "./fakes/fakeClaudeStream.js";
import { createFakeCodexSpawn } from "./fakes/fakeCodexAppServer.js";

function waitForNotification(
  notifications: MspNotification[],
  predicate: (n: MspNotification) => boolean,
  timeoutMs = 2000,
): Promise<MspNotification> {
  const found = notifications.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const match = notifications.find(predicate);
      if (match) {
        clearInterval(timer);
        resolve(match);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for notification; saw: ${notifications.map((n) => n.method).join(", ")}`));
      }
    }, 10);
  });
}

describe("ACP driver conformance (Gemini / Copilot / Custom ACP)", () => {
  it("streams thoughts, tool calls, messages, approvals, usage, and hydrates from journal across restarts", async () => {
    const store = new AncillaStore(":memory:");
    const journal = store.sessionJournal();
    const host = new AcpAgentHost(
      { command: "gemini", args: ["--acp"], cwd: "/tmp" },
      { providerId: "gemini", spawnFn: createFakeAcpSpawn({ requirePermissionForPrompt: "NEEDS_PERM" }), journal },
    );
    await host.start("0.27.3");

    const manager = new SessionManager(host.connection, {
      providerId: host.providerId,
      capabilities: host.capabilities,
    });
    const notifications: MspNotification[] = [];
    manager.onNotification((n) => notifications.push(n));

    const started = await manager.startSession({ workspaceRoot: "/tmp" });
    assert.ok(started.sessionId);

    const models = (await manager.listModels()) as { models: { modelId: string }[] };
    assert.ok(models.models.some((m) => m.modelId === "gemini-2.5-pro"));

    await manager.sendTurn(started.sessionId, "hello acp");
    await waitForNotification(
      notifications,
      (n) => n.method === "turn/completed" && (n.params as Record<string, unknown>)?.["sessionId"] === started.sessionId,
    );

    assert.ok(
      notifications.some(
        (n) => n.method === "item/delta" && (n.params as Record<string, unknown>)?.["field"] === "summary.0",
      ),
    );
    assert.ok(
      notifications.some(
        (n) => n.method === "item/delta" && (n.params as Record<string, unknown>)?.["field"] === "text",
      ),
    );
    assert.ok(notifications.some((n) => n.method === "session/tokenUsage"));

    // Interactive permission prompt -> Ancilla approval decision
    const beforePermCount = notifications.filter((n) => n.method === "turn/completed").length;
    await manager.sendTurn(started.sessionId, "NEEDS_PERM run suite");
    const approvalReq = await waitForNotification(notifications, (n) => n.method === "approval/requested");
    const reqParams = approvalReq.params as Record<string, unknown>;
    await manager.decideApproval({
      sessionId: started.sessionId,
      approvalId: String(reqParams["approvalId"]),
      requirementId: reqParams["requirementId"],
      choiceId: "allow",
    });
    await waitForNotification(
      notifications,
      () => notifications.filter((n) => n.method === "turn/completed").length > beforePermCount,
    );

    // Unsupported capability throws UnsupportedCapabilityError cleanly
    await assert.rejects(
      () => manager.goal(started.sessionId, "set", "ship feature"),
      (err: unknown) => err instanceof UnsupportedCapabilityError && err.status === 400,
    );

    await host.close();

    // Reopen a fresh host over the same SQLite journal and verify full transcript replay
    const reopenedHost = new AcpAgentHost(
      { command: "gemini", args: ["--acp"], cwd: "/tmp" },
      { providerId: "gemini", spawnFn: createFakeAcpSpawn(), journal },
    );
    await reopenedHost.start("0.27.3");
    const reopenedManager = new SessionManager(reopenedHost.connection, {
      providerId: reopenedHost.providerId,
      capabilities: reopenedHost.capabilities,
    });
    await reopenedManager.resumeSession(started.sessionId, true);
    const page = await reopenedManager.pageView(started.sessionId, { direction: "backward", limit: 200 });
    assert.ok(page.events.length > 0, "journal events replayed on reopened host");
    await reopenedHost.close();
    store.close();
  });

  it("discovers live subscription models via session/new probe before startSession and supports ACP configOptions", async () => {
    const configCalls: Record<string, unknown>[] = [];
    const host = new AcpAgentHost(
      { command: "copilot", args: ["--acp", "--stdio"], cwd: "/tmp" },
      {
        providerId: "copilot",
        spawnFn: createFakeAcpSpawn({
          useConfigOptionsForModels: true,
          onSetConfigOption: (params) => configCalls.push(params),
        }),
      },
    );
    await host.start("0.27.3");
    const manager = new SessionManager(host.connection, {
      providerId: host.providerId,
      capabilities: host.capabilities,
    });

    // Called BEFORE startSession — should probe session/new and parse grouped configOptions
    const catalog = (await manager.listModels()) as {
      source: string;
      models: { modelId: string; displayLabel: string; isDefault: boolean; variants?: string[] }[];
    };
    assert.equal(catalog.source, "providerCatalog");
    assert.deepEqual(
      catalog.models.map((m) => [m.modelId, m.isDefault]),
      [
        ["claude-opus-4.6", false],
        ["claude-sonnet-4.6", true],
      ],
    );
    assert.deepEqual(catalog.models[0]?.variants, ["low", "medium", "high"]);

    const started = await manager.startSession({ workspaceRoot: "/tmp" });
    assert.equal((started.raw as { session?: { modelId?: string } }).session?.modelId, "claude-sonnet-4.6");
    await manager.setSessionModel(started.sessionId, "claude-opus-4.6");
    assert.ok(configCalls.some((c) => c["configId"] === "model_choice" && c["value"] === "claude-opus-4.6"));

    await host.close();
  });
});

describe("OpenAI Codex app-server driver conformance", () => {
  it("supports thread start, rate limits, models, approvals, interactive questions, fork, and compact", async () => {
    const host = new CodexAppServerHost(
      { command: "codex", args: ["app-server", "--listen", "stdio://"], cwd: "/tmp" },
      {
        spawnFn: createFakeCodexSpawn({
          requireApprovalOnPrompt: "CHECK_GIT",
          requireQuestionOnPrompt: "ASK_ENV",
        }),
      },
    );
    await host.start("0.27.3");
    const manager = new SessionManager(host.connection, {
      providerId: host.providerId,
      capabilities: host.capabilities,
    });
    const notifications: MspNotification[] = [];
    manager.onNotification((n) => notifications.push(n));

    const started = await manager.startSession({ workspaceRoot: "/tmp" });

    // Rate-limit window read
    await waitForNotification(notifications, (n) => n.method === "usage/changed");
    const subUsage = await manager.readSubscriptionUsage();
    assert.ok(subUsage);
    assert.equal(subUsage.tier, "pro");
    assert.equal(subUsage.window.usedPercent, 22.5);

    // Model list
    const models = (await manager.listModels()) as { models: { modelId: string }[] };
    assert.ok(models.models.some((m) => m.modelId === "gpt-5.3-codex"));

    // Turn with both approval & interactive userInput question
    await manager.sendTurn(started.sessionId, "CHECK_GIT and ASK_ENV");
    const approvalReq = await waitForNotification(notifications, (n) => n.method === "approval/requested");
    const apParams = approvalReq.params as Record<string, unknown>;
    await manager.decideApproval({
      sessionId: started.sessionId,
      approvalId: String(apParams["approvalId"]),
      requirementId: apParams["requirementId"],
      choiceId: "allow",
    });

    const qReq = await waitForNotification(notifications, (n) => n.method === "userInput/requested");
    const qParams = qReq.params as Record<string, unknown>;
    await manager.answerUserInput(started.sessionId, String(qParams["userInputId"]), [
      { questionId: "q_env", selectedLabel: "staging" },
    ]);

    await waitForNotification(notifications, (n) => n.method === "turn/completed");
    const page = await manager.pageView(started.sessionId, { direction: "forward", limit: 100 });
    const completedText = JSON.stringify(page.events);
    assert.ok(completedText.includes("[env=staging]"));

    const forked = await manager.forkSession(started.sessionId);
    assert.notEqual(forked.sessionId, started.sessionId);
    await manager.compactSession(started.sessionId);

    await host.close();
  });

  it("paginates model/list, filters hidden models, preserves subscription isDefault, and exposes reasoning efforts", async () => {
    const host = new CodexAppServerHost(
      { command: "codex", args: ["app-server", "--listen", "stdio://"], cwd: "/tmp" },
      {
        spawnFn: createFakeCodexSpawn({
          defaultThreadModel: "gpt-5.4",
          modelPages: [
            {
              data: [
                {
                  id: "gpt-5.2-codex",
                  displayName: "GPT-5.2 Codex",
                  hidden: false,
                  isDefault: false,
                  inputTokenLimit: 272_000,
                  supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }],
                },
                {
                  id: "gpt-internal-hidden",
                  displayName: "Hidden Internal",
                  hidden: true,
                  isDefault: false,
                },
              ],
              nextCursor: "1",
            },
            {
              data: [
                {
                  id: "gpt-5.4",
                  displayName: "GPT-5.4",
                  description: "Latest frontier agentic model",
                  hidden: false,
                  isDefault: true,
                  inputTokenLimit: 400_000,
                  supportedReasoningEfforts: [
                    { reasoningEffort: "low" },
                    { reasoningEffort: "medium" },
                    { reasoningEffort: "high" },
                    { reasoningEffort: "xhigh" },
                  ],
                },
              ],
              nextCursor: null,
            },
          ],
        }),
      },
    );
    await host.start("0.27.3");
    const manager = new SessionManager(host.connection, {
      providerId: host.providerId,
      capabilities: host.capabilities,
    });

    const catalog = (await manager.listModels()) as {
      source: string;
      models: { modelId: string; isDefault: boolean; contextLimit: number | null; variants?: string[] }[];
    };
    assert.equal(catalog.source, "providerCatalog");
    assert.deepEqual(
      catalog.models.map((m) => [m.modelId, m.isDefault, m.contextLimit]),
      [
        ["gpt-5.2-codex", false, 272_000],
        ["gpt-5.4", true, 400_000],
      ],
    );
    assert.deepEqual(catalog.models[1]?.variants, ["low", "medium", "high", "xhigh"]);

    // Starting a default session without specifying modelId uses Codex's real subscription default, not seedModels[0]
    const started = await manager.startSession({ workspaceRoot: "/tmp" });
    assert.equal((started.raw as { session?: { modelId?: string } }).session?.modelId, "gpt-5.4");

    await host.close();
  });
});

describe("Anthropic Claude stream-json driver conformance", () => {
  it("streams thinking + text blocks, bridges can_use_tool permission requests, and records usage", async () => {
    const host = new ClaudeCliStreamHost(
      { command: "claude", args: ["-p", "--input-format", "stream-json"], cwd: "/tmp" },
      { spawnFn: createFakeClaudeSpawn({ requireApprovalOnPrompt: "RUN_BASH" }) },
    );
    await host.start("0.27.3");
    const manager = new SessionManager(host.connection, {
      providerId: host.providerId,
      capabilities: host.capabilities,
    });
    const notifications: MspNotification[] = [];
    manager.onNotification((n) => notifications.push(n));

    const started = await manager.startSession({ workspaceRoot: "/tmp", modelId: "claude-sonnet-4-6" });
    await manager.sendTurn(started.sessionId, "RUN_BASH check files");

    const approvalReq = await waitForNotification(notifications, (n) => n.method === "approval/requested");
    const apParams = approvalReq.params as Record<string, unknown>;
    await manager.decideApproval({
      sessionId: started.sessionId,
      approvalId: String(apParams["approvalId"]),
      requirementId: apParams["requirementId"],
      choiceId: "deny",
      feedback: "Read-only check please",
    });

    await waitForNotification(notifications, (n) => n.method === "turn/completed");
    const view = await manager.pageView(started.sessionId, { direction: "forward", limit: 100 });
    assert.ok(JSON.stringify(view.events).includes("Read-only check please"));

    await host.close();
  });

  it("discovers live Claude Code subscription models via stream-json control_request initialize", async () => {
    const host = new ClaudeCliStreamHost(
      { command: "claude", args: ["-p", "--input-format", "stream-json"], cwd: "/tmp" },
      {
        spawnFn: createFakeClaudeSpawn({
          tokenSource: "oauth",
          models: [
            {
              value: "default",
              resolvedModel: "claude-fable-1m",
              displayName: "Default (recommended)",
              description: "Recommended for your Max plan",
            },
            {
              value: "fable[1m]",
              resolvedModel: "claude-fable-1m",
              displayName: "Opus (1M context)",
              description: "Opus 4.6 with 1M context window",
              supportedEffortLevels: ["low", "medium", "high", "max"],
              supportsThinkingOff: true,
            },
            {
              value: "sonnet",
              resolvedModel: "claude-sonnet-4-6",
              displayName: "Sonnet",
              description: "Sonnet 4.6 · Best for everyday tasks",
              supportedEffortLevels: ["low", "medium", "high"],
            },
          ],
        }),
      },
    );
    await host.start("0.27.3");
    const manager = new SessionManager(host.connection, {
      providerId: host.providerId,
      capabilities: host.capabilities,
    });

    const catalog = (await manager.listModels()) as {
      source: string;
      models: { modelId: string; displayLabel: string; isDefault: boolean; contextLimit: number | null; variants?: string[] }[];
    };
    assert.equal(catalog.source, "providerCatalog");
    assert.deepEqual(
      catalog.models.map((m) => [m.modelId, m.displayLabel, m.isDefault, m.contextLimit ?? null]),
      [
        ["fable[1m]", "Opus (1M context)", true, 1_000_000],
        ["sonnet", "Sonnet", false, null],
      ],
    );
    assert.deepEqual(catalog.models[0]?.variants, ["none", "low", "medium", "high", "max"]);

    await host.close();
  });
});

describe("AncillaStore provider accounts & runtime planning", () => {
  it("persists provider_accounts, project defaultProviderId, session providerId, and plans CLI targets", async () => {
    const store = new AncillaStore(":memory:");
    const project = store.upsertProject("/work/demo");
    assert.equal(project.defaultProviderId, "muse");

    const account = store.upsertProviderAccount({
      id: "codex-work",
      providerId: "codex",
      name: "Work ChatGPT Pro",
      stripAmbientKeys: true,
    });
    assert.equal(account.providerId, "codex");
    assert.equal(account.stripAmbientKeys, true);

    store.setDefaultProvider("/work/demo", "codex", "codex-work");
    const updated = store.getProject("/work/demo")!;
    assert.equal(updated.defaultProviderId, "codex");
    assert.equal(updated.defaultAccountId, "codex-work");

    const session = store.recordSession({
      id: "sess_codex_1",
      projectId: updated.id,
      providerId: "codex",
      accountId: "codex-work",
    });
    assert.equal(session.providerId, "codex");
    assert.equal(session.accountId, "codex-work");

    store.deleteProviderAccount("codex-work");
    assert.equal(store.getProject("/work/demo")!.defaultAccountId, null);

    // Runtime planning across POSIX and WSL2
    const posixPlan = planProviderServe({
      providerId: "codex",
      platform: "linux",
      cwd: "/work/demo",
      binaryPath: "/usr/local/bin/codex",
    });
    assert.equal(posixPlan.command, "/usr/local/bin/codex");
    assert.deepEqual(posixPlan.args, ["app-server", "--listen", "stdio://"]);

    const wslPlan = planProviderCli({
      providerId: "claude",
      platform: "win32",
      distro: "Ubuntu",
      runtime: "wsl",
      binaryPath: "/home/u/.local/bin/claude",
      args: ["auth", "status", "--json"],
    });
    assert.equal(wslPlan.command, "wsl");
    assert.deepEqual(wslPlan.args, ["-d", "Ubuntu", "-e", "/home/u/.local/bin/claude", "auth", "status", "--json"]);

    const probe = await probeProviderBinary("gemini", {
      platform: "linux",
      exec: async (_cmd, args) => {
        if (args.join(" ").includes("command -v")) {
          return { stdout: "/usr/bin/gemini\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "0.9.1\n", stderr: "", exitCode: 0 };
      },
    });
    assert.equal(probe.available, true);
    assert.equal(probe.binaryPath, "/usr/bin/gemini");
    assert.equal(probe.version, "0.9.1");

    store.close();
  });
});
