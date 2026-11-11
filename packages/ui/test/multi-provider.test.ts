import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { About } from "../src/components/settings/About.js";
import { ProvidersSettings } from "../src/components/settings/ProvidersSettings.js";
import { ThreadRow } from "../src/components/sidebar/Sidebar.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import { ProviderQuotasSection } from "../src/components/usage/UsagePage.js";
import type { AncillaController } from "../src/model/controller.js";
import { parseModelList } from "../src/client.js";
import { slashMenuOver } from "../src/components/composer/Composer.js";
import {
  MODEL_COPY,
  isModelId,
  literalModelId,
  modelIdError,
  modelMenu,
  modelsKey,
  modelsShown,
  providerBadgeName,
} from "../src/model/models.js";
import { slashCommands } from "../src/model/slash.js";
import { listedPrice, publishedModelIds } from "../src/model/pricing.js";
import { threadStatus } from "../src/model/status.js";
import { defaultPrefs, initialState, Store, type AppState } from "../src/model/store.js";
import type { ProviderCapabilities, ProviderQuotaView, ProviderView, SessionSummary } from "../src/types.js";

const CAPS: ProviderCapabilities = {
  transport: "codex-app-server",
  authKind: "cli-oauth",
  supportsResume: true,
  supportsFork: true,
  supportsCompact: true,
  supportsSteer: true,
  supportsReasoningEffort: true,
  supportsApprovalModes: ["allowAll", "onRequest"],
  supportsInteractiveQuestions: true,
  supportsSkills: false,
  supportsGoals: false,
  supportsSubagents: false,
  supportsOutputPaging: false,
  supportsImageAttachments: true,
  supportsNativeWebSearch: true,
  quotaSupport: "windows",
};

function renderInApp(element: ReactElement, extra: Partial<AppState> = {}): string {
  const store = new Store<AppState>({
    ...initialState(defaultPrefs("2026-10-01T00:00:00.000Z")),
    connection: "open",
    ...extra,
  });
  const controller = {
    store,
    loadProviders: async () => {},
    loadAccounts: async () => {},
    openThread: () => {},
  } as unknown as AncillaController;
  return renderToStaticMarkup(
    createElement(ControllerProvider, {
      controller,
      children: createElement(TooltipProvider, { children: element }),
    }),
  );
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("multi-provider model scoping and pricing", () => {
  it("scopes model caches by provider and account while preserving Muse keys", () => {
    assert.equal(modelsKey({}), "default");
    assert.equal(modelsKey({ providerId: "muse", accountId: "work" }), "acct:work");
    assert.equal(modelsKey({ providerId: "codex", accountId: null }), "prov:codex:default");
    assert.equal(modelsKey({ providerId: "claude", accountId: "claude-work" }), "prov:claude:claude-work");
    assert.equal(modelsKey({ sessionId: "s42", providerId: "gemini" }), "thread:s42");
  });

  it("uses Muse fallback only for Muse accounts and never substitutes Muse models into non-Muse scopes", () => {
    const museModel = {
      modelId: "muse-spark-1.3",
      displayLabel: "Muse Spark 1.3",
      description: null,
      isDefault: true,
      isActive: false,
      contextLimit: 200_000,
      outputLimit: null,
      cost: null,
      contributor: false,
    };
    const state = {
      ...initialState(defaultPrefs("2026-10-01T00:00:00.000Z")),
      models: [museModel],
      modelsStatus: {
        "acct:work": { status: "error" as const, error: "offline", loadedAt: null, catalog: null },
        "prov:codex:default": { status: "error" as const, error: "offline", loadedAt: null, catalog: null },
      },
    };
    const museFallback = modelsShown(state, { providerId: "muse", accountId: "work" });
    assert.equal(museFallback.fallback, true);
    assert.ok(museFallback.models.some((m) => m.modelId === "muse-spark-1.3"));

    const codexEmpty = modelsShown(state, { providerId: "codex" });
    assert.equal(codexEmpty.fallback, false);
    assert.equal(codexEmpty.models.length, 0);
  });

  it("formats provider badge names cleanly", () => {
    assert.equal(providerBadgeName("codex"), "Codex");
    assert.equal(providerBadgeName("claude"), "Claude");
    assert.equal(providerBadgeName("gemini"), "Gemini");
    assert.equal(providerBadgeName("copilot"), "Copilot");
    assert.equal(providerBadgeName("api"), "API");
    assert.equal(providerBadgeName("acp:aider"), "aider");
  });

  it("prices common OpenAI, Anthropic, and Google models without polluting publishedModelIds()", () => {
    const museIds = publishedModelIds();
    assert.ok(museIds.includes("muse-spark-1.3"));
    assert.ok(!museIds.some((id) => id.startsWith("claude") || id.startsWith("gpt-") || id.startsWith("gemini-")));

    assert.ok(listedPrice("gpt-5.4") !== null);
    assert.ok(listedPrice("claude-sonnet-4-6") !== null);
    assert.ok(listedPrice("anthropic/claude-sonnet-4.6") !== null);
    assert.ok(listedPrice("gemini-2.5-pro") !== null);
  });
});

describe("ProvidersSettings, ProviderQuotasSection, About, and ThreadRow badges", () => {
  const PROVIDERS: ProviderView[] = [
    {
      id: "codex",
      displayName: "OpenAI Codex",
      vendorName: "OpenAI",
      subscriptionSummary: "ChatGPT Plus, Pro, Team, Edu & Enterprise",
      binaryName: "codex",
      serveArgs: ["app-server", "--listen", "stdio://"],
      loginArgs: ["login"],
      installDocsUrl: "https://developers.openai.com/codex/cli",
      usageDashboardUrl: "https://chatgpt.com/codex/settings/usage",
      capabilities: CAPS,
      binary: { providerId: "codex", available: true, runtime: "posix", binaryPath: "/usr/local/bin/codex", distro: null, version: "0.42.0" },
      ambientKeyOverrides: ["OPENAI_API_KEY"],
      defaultAuth: { state: "authenticated", summary: "ChatGPT Plus", email: null, planTier: "plus", authMethod: "chatgpt" },
      accounts: [],
    },
    {
      id: "api",
      displayName: "Direct API & Local",
      vendorName: "Direct HTTP",
      subscriptionSummary: "OpenRouter, Venice, BYOK & Local Servers",
      binaryName: null,
      serveArgs: [],
      loginArgs: null,
      installDocsUrl: null,
      usageDashboardUrl: null,
      capabilities: { ...CAPS, transport: "http-api", authKind: "api-key", quotaSupport: "ledger-only" },
      binary: { providerId: "api", available: true, runtime: "builtin", binaryPath: null, distro: null, version: null },
      ambientKeyOverrides: [],
      defaultAuth: { state: "ready", summary: null, email: null, planTier: null, authMethod: null },
      accounts: [
        {
          id: "api-openrouter",
          providerId: "api",
          name: "OpenRouter",
          runtimeOverride: null,
          binaryPath: null,
          customArgs: [],
          apiKind: "openai",
          apiBaseUrl: "https://openrouter.ai/api/v1",
          hasApiKey: true,
          stripAmbientKeys: false,
          defaultModelId: "anthropic/claude-sonnet-4.6",
          customModels: [],
          createdAt: "2026-10-01T00:00:00.000Z",
          lastUsedAt: null,
        },
      ],
    },
  ];

  it("renders subscription CLIs, ambient API-key stripping warning, and Direct API endpoints", () => {
    const html = renderInApp(createElement(ProvidersSettings), {
      providers: PROVIDERS,
      ambientKeyOverrides: { codex: ["OPENAI_API_KEY"] },
    });
    const plain = text(html);
    assert.match(plain, /OpenAI Codex/);
    assert.match(plain, /Signed in \(plus\)/);
    assert.match(plain, /Ambient API keys detected \(OPENAI_API_KEY\)/);
    assert.match(plain, /OpenRouter/);
    assert.match(plain, /Key saved/);
  });

  it("renders honest non-Muse quota cards on Usage and stays absent when empty", () => {
    assert.equal(renderInApp(createElement(ProviderQuotasSection), { providerQuotas: [] }), "");

    const quotas: ProviderQuotaView[] = [
      {
        providerId: "codex",
        displayName: "OpenAI Codex",
        accountId: null,
        accountName: null,
        quotaSupport: "windows",
        usageDashboardUrl: "https://chatgpt.com/codex/settings/usage",
        usage: {
          tier: "plus",
          observedAtMs: 1_700_000_000_000,
          window: { usedPercent: 35, resetsAtMs: 1_700_010_000_000, windowDurationMins: 300 },
          weekly: { usedPercent: 20, resetsAtMs: 1_700_500_000_000, windowDurationMins: null },
        },
      },
      {
        providerId: "claude",
        displayName: "Anthropic Claude",
        accountId: "claude-work",
        accountName: "Work",
        quotaSupport: "tier-only",
        usageDashboardUrl: "https://claude.ai/settings/usage",
        usage: null,
      },
    ];

    const html = renderInApp(createElement(ProviderQuotasSection), { providerQuotas: quotas });
    const plain = text(html);
    assert.match(plain, /35% used · 65% left/);
    assert.match(plain, /20% used · 80% left/);
    assert.match(plain, /Anthropic Claude · Work/);
    assert.match(plain, /does not expose numeric remaining percentages over stdio/);
  });

  it("surfaces the AGPLv3 §13 Complete Corresponding Source Code offer when remoteDeployment is active", () => {
    const localHtml = renderToStaticMarkup(createElement(About, { version: "0.27.3", remoteDeployment: false }));
    assert.doesNotMatch(localHtml, /AGPLv3 §13/);

    const remoteHtml = renderToStaticMarkup(
      createElement(About, {
        version: "0.27.3",
        remoteDeployment: true,
        sourceOfferUrl: "https://github.com/aleff-ferreira/ancilla",
      }),
    );
    assert.match(text(remoteHtml), /GNU AGPLv3 §13/);
    assert.ok(remoteHtml.includes('href="https://github.com/aleff-ferreira/ancilla"'));
  });

  it("renders provider badges on non-Muse sidebar threads without altering default Muse threads", () => {
    const baseSession: SessionSummary = {
      sessionId: "s-muse",
      cwd: "/work/app",
      title: "Fix tests",
      titleSource: "auto",
      turnCount: 1,
      modelId: "muse-spark-1.3",
      origin: "ancilla",
      archived: false,
      createdAt: "2026-10-01T00:00:00.000Z",
      activityAt: "2026-10-01T00:00:00.000Z",
      settled: false,
      settledAt: null,
      unsettledAt: null,
      sandboxDisabled: false,
      accountId: null,
      live: null,
    };
    const codexSession: SessionSummary = {
      ...baseSession,
      sessionId: "s-codex",
      providerId: "codex",
      modelId: "gpt-5.4",
    };

    const statusOpts = { fold: null, lastSeen: null, baseline: "2026-10-01T00:00:00.000Z", active: false };
    const museHtml = renderInApp(
      createElement(ThreadRow, {
        entry: { session: baseSession, status: threadStatus(baseSession, statusOpts) },
        active: false,
        now: Date.parse("2026-10-01T00:05:00.000Z"),
      }),
    );
    assert.doesNotMatch(museHtml, /Provider:/);

    const codexHtml = renderInApp(
      createElement(ThreadRow, {
        entry: { session: codexSession, status: threadStatus(codexSession, statusOpts) },
        active: false,
        now: Date.parse("2026-10-01T00:05:00.000Z"),
      }),
    );
    assert.match(codexHtml, /title="Provider: Codex"/);
  });
});

describe("provider-aware model selector, IDs, efforts, and sign-in prompts", () => {
  it("suppresses contradictory empty copy on Muse 1.4.15 empty bundledCatalog and offers default Muse sign-in when unauthenticated", () => {
    const emptyBundledStatus = {
      default: {
        status: "ready" as const,
        error: null,
        loadedAt: 1_000,
        catalog: { source: "bundledCatalog", providerId: "meta", profileId: "default", hostVersion: "1.4.15" },
      },
    };
    const baseMenu = modelMenu(
      { models: [], accountModels: { default: [] }, modelsStatus: emptyBundledStatus, accounts: null },
      { scope: {}, accountId: null, current: null, pref: "muse-spark-1.3", plan: null },
    );
    assert.equal(baseMenu.limited, true);
    assert.equal(baseMenu.message, null, "never shows 'Muse listed no models' alongside the built-in catalog notice");
    assert.deepEqual(baseMenu.notes, [MODEL_COPY.limited]);
    assert.ok(baseMenu.published.some((p) => p.id === "muse-wonder-1.0"));

    // When default Muse login has no login or rejected credentials, surface Sign in with Meta directly in ModelMenu
    const signedOutMenu = modelMenu(
      {
        models: [],
        accountModels: { default: [] },
        modelsStatus: emptyBundledStatus,
        accounts: null,
        defaultLogin: { hasLogin: false, email: null },
      },
      { scope: {}, accountId: null, current: null, pref: null, plan: null },
    );
    assert.deepEqual(signedOutMenu.signIn, { id: null, name: "Muse" });
    assert.match(signedOutMenu.message ?? "", /Sign in with Meta/);

    const rejectedMenu = modelMenu(
      {
        models: [],
        accountModels: { default: [] },
        modelsStatus: emptyBundledStatus,
        accounts: null,
        planUsageAccounts: [{ accountId: null, status: "login-required" }],
      },
      { scope: {}, accountId: null, current: null, pref: null, plan: null },
    );
    assert.deepEqual(rejectedMenu.signIn, { id: null, name: "Muse" });
  });

  it("accepts Claude [1m], OpenRouter vendor/model, and Ollama tag IDs, and parses supportedReasoningEfforts", () => {
    for (const id of ["fable[1m]", "claude-opus-4-6[1m]", "openai/gpt-5.4", "anthropic/claude-sonnet-4.6", "qwen3:8b"]) {
      assert.equal(isModelId(id), true, id);
      assert.equal(modelIdError(id), null, id);
      assert.equal(literalModelId(id, []), id, id);
    }

    const parsed = parseModelList({
      models: [
        {
          modelId: "gpt-5.4",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
            { reasoningEffort: "xhigh" },
          ],
        },
      ],
    });
    assert.deepEqual(parsed[0]?.efforts, ["low", "medium", "high", "xhigh"]);
  });

  it("uses provider-specific labels, omits Meta published stubs, and offers provider sign-in on non-Muse scopes", () => {
    const unauthedCodex: ProviderView = {
      id: "codex",
      displayName: "OpenAI Codex",
      vendorName: "OpenAI",
      subscriptionSummary: "ChatGPT Plus & Pro",
      binaryName: "codex",
      serveArgs: ["app-server", "--listen", "stdio://"],
      loginArgs: ["login"],
      installDocsUrl: null,
      usageDashboardUrl: null,
      capabilities: CAPS,
      binary: { providerId: "codex", available: true, runtime: "posix", binaryPath: "/usr/bin/codex", distro: null, version: "0.42.0" },
      ambientKeyOverrides: [],
      defaultAuth: { state: "unauthenticated", summary: "Not signed in", email: null, planTier: null, authMethod: null },
      accounts: [],
    };
    const key = modelsKey({ providerId: "codex", accountId: null });
    const statuses = {
      [key]: {
        status: "ready" as const,
        error: null,
        loadedAt: 1_000,
        catalog: { source: "bundledCatalog", providerId: "codex", profileId: null, hostVersion: "0.42.0" },
      },
    };
    const fallbackRows = [
      {
        modelId: "gpt-5.4",
        displayLabel: "GPT-5.4",
        description: "Flagship",
        isDefault: true,
        isActive: false,
        contextLimit: 400_000,
        outputLimit: null,
        cost: null,
        contributor: false,
      },
    ];
    const source = {
      models: fallbackRows,
      accountModels: { [key]: fallbackRows },
      modelsStatus: statuses,
      accounts: null,
      providers: [unauthedCodex],
    };

    const menu = modelMenu(source, {
      scope: { providerId: "codex", accountId: null },
      accountId: null,
      current: null,
      pref: null,
      plan: null,
    });
    assert.equal(menu.rows[0]?.label, "Codex default");
    assert.deepEqual(menu.published, [], "never lists Meta published stubs on non-Muse providers");
    assert.equal(menu.footer.line, "Codex 0.42.0");
    assert.equal(menu.footer.hint, null);
    assert.equal(menu.signIn?.providerId, "codex");
    assert.equal(menu.signIn?.actionLabel, "Sign in to OpenAI Codex");

    // /model slash completions on a non-Muse limited list must not autocomplete Meta's muse-wonder-1.0
    const slash = slashMenuOver("/model ", 7, slashCommands([], { inThread: true }), undefined, source, { providerId: "codex" });
    assert.equal(slash?.kind, "models");
    if (slash?.kind === "models") {
      assert.deepEqual(slash.items.map((i) => i.id), ["gpt-5.4"]);
    }
  });
});
