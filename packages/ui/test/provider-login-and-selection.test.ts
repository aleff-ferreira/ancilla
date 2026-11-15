import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ControllerProvider } from "../src/app/context.js";
import type { AncillaClient } from "../src/client.js";
import { NewThread } from "../src/components/home/Home.js";
import { ProviderLoginBody } from "../src/components/settings/ProvidersSettings.js";
import { ModelPick } from "../src/components/settings/SettingsPage.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import { AncillaController, type Platform } from "../src/model/controller.js";
import { defaultPrefs, initialState, Store, type AppState, type Prefs } from "../src/model/store.js";
import type {
  AccountLoginProgress,
  ModelCatalog,
  ModelOption,
  ProviderId,
  ProviderLoginResult,
  ProvidersCatalogView,
  ProviderView,
} from "../src/types.js";

function renderWithState<P extends object>(
  Component: ComponentType<P>,
  props: P,
  patch: Partial<AppState> = {},
  prefs: Partial<Prefs> = {},
): string {
  const base = initialState({
    ...defaultPrefs("2026-11-12T00:00:00.000Z"),
    ...prefs,
  });
  const store = new Store<AppState>({
    ...base,
    connection: "open",
    ...patch,
  });
  const controller = ({
    store,
    cancelProviderLogin: () => {},
    checkProviderLogin: async () => {},
    beginProviderLogin: async () => {},
    submitProviderLoginCode: async () => true,
    refreshModels: async () => {},
    openThread: () => {},
    navigate: () => {},
  } as unknown) as AncillaController;

  return renderToStaticMarkup(
    createElement(ControllerProvider, {
      controller,
      children: createElement(TooltipProvider, {
        children: createElement(Component, props),
      }),
    }),
  );
}

function makeClaudeProviderView(authenticated: boolean): ProviderView {
  return {
    id: "claude",
    displayName: "Claude Code",
    vendorName: "Anthropic",
    subscriptionSummary: "Claude Pro, Max, Team & Enterprise",
    binaryName: "claude",
    serveArgs: ["-p"],
    loginArgs: ["auth", "login"],
    installDocsUrl: "https://docs.anthropic.com",
    usageDashboardUrl: "https://claude.ai/settings/usage",
    capabilities: {
      transport: "claude-stream-json",
      authKind: "cli-oauth",
      supportsResume: true,
      supportsFork: true,
      supportsCompact: true,
      supportsSteer: false,
      supportsReasoningEffort: true,
      supportsApprovalModes: ["onRequest", "allowAll"],
      supportsInteractiveQuestions: true,
      supportsSkills: true,
      supportsGoals: false,
      supportsSubagents: true,
      supportsOutputPaging: false,
      supportsImageAttachments: true,
      supportsNativeWebSearch: true,
      quotaSupport: "tier-only",
    },
    binary: {
      providerId: "claude",
      available: true,
      runtime: "wsl",
      binaryPath: "/home/aleff/.local/bin/claude",
      distro: "ubuntu",
      version: "2.1.310",
    },
    ambientKeyOverrides: [],
    defaultAuth: authenticated
      ? { state: "authenticated", summary: "Signed in (Max)", email: "user@example.com", planTier: "Max", authMethod: "oauth" }
      : { state: "unauthenticated", summary: null, email: null, planTier: null, authMethod: "oauth" },
    accounts: [],
  };
}

describe("ProviderLoginModal & CLI provider sign-in controller flow", () => {
  it("renders untruncated Claude OAuth URL, authorization code input form, and never renders a bogus 'true' code badge", () => {
    const fullUrl =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&state=xyz_123";
    const html = renderWithState(ProviderLoginBody, {}, {
      providers: [makeClaudeProviderView(false)],
      providerLogin: {
        providerId: "claude",
        accountId: null,
        status: "waiting",
        url: fullUrl,
        code: null,
        needsCodeInput: true,
        loginId: "login-1",
        terminalCommand: "/home/aleff/.local/bin/claude auth login",
      },
    });

    assert.ok(html.includes("Authorization code from browser"));
    assert.ok(html.includes("Complete sign-in"));
    assert.ok(html.includes("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e"));
    assert.ok(!html.includes(">true</code>"), "must never display ?code=true query flag as a verification code");
  });

  it("renders Try again button when provider login enters error state", () => {
    const html = renderWithState(ProviderLoginBody, {}, {
      providers: [makeClaudeProviderView(false)],
      providerLogin: {
        providerId: "claude",
        accountId: null,
        status: "error",
        url: null,
        code: null,
        loginId: "login-err",
        message: "OAuth error: Invalid or expired authorization code.",
      },
    });
    assert.ok(html.includes("OAuth error: Invalid or expired authorization code."));
    assert.ok(html.includes("Try again"));
  });

  it("submits pasted authorization code via controller, transitions to done, and force-refreshes live provider models", async () => {
    let authed = false;
    const submittedCodes: { providerId: ProviderId; loginId: string; code: string; accountId?: string | null }[] = [];
    const catalogCalls: { providerId?: ProviderId | null; refresh?: boolean }[] = [];

    const liveClaudeModels: ModelOption[] = [
      {
        modelId: "opus",
        displayLabel: "Opus",
        description: "Opus 5.5 · Best for everyday, complex tasks",
        isDefault: true,
        isActive: true,
        contextLimit: 200_000,
        outputLimit: null,
        cost: null,
        contributor: false,
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        modelId: "fable[1m]",
        displayLabel: "Fable",
        description: "Fable 5.1 · Most capable for your hardest tasks",
        isDefault: false,
        isActive: false,
        contextLimit: 1_000_000,
        outputLimit: null,
        cost: null,
        contributor: false,
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
    ];

    const platform: Platform = {
      loadPrefs: () => null,
      savePrefs: () => {},
      readHash: () => "",
      writeHash: () => {},
      onHashChange: () => () => {},
      now: () => Date.now(),
      schedule: (fn) => setTimeout(fn, 50),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      focused: () => true,
    };

    const client = ({
      listProviders: async (): Promise<ProvidersCatalogView> => ({
        providers: [makeClaudeProviderView(authed)],
        accounts: [],
        ambientKeyOverrides: {},
        remoteDeployment: false,
        license: "AGPL-3.0-only",
        sourceOfferUrl: "https://github.com/aleff-ferreira/ancilla",
      }),
      planUsage: async () => ({
        usage: null,
        accountId: null,
        saved: false,
        savedAccounts: [],
        byAccount: {},
        accounts: [],
        providerQuotas: [],
      }),
      loginProvider: async (): Promise<ProviderLoginResult> => ({
        status: "waiting",
        url: "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=st1",
        code: null,
        needsCodeInput: true,
        loginId: "login-claude-1",
        terminalCommand: "claude auth login",
      }),
      submitProviderLoginCode: async (
        providerId: ProviderId,
        loginId: string,
        code: string,
        accountId?: string | null,
      ): Promise<AccountLoginProgress> => {
        submittedCodes.push({ providerId, loginId, code, accountId });
        authed = true;
        return { status: "done" };
      },
      listModelCatalog: async (
        _sessionId?: string,
        _accountId?: string | null,
        providerId?: ProviderId | null,
        options?: { refresh?: boolean },
      ): Promise<ModelCatalog> => {
        catalogCalls.push({ providerId, refresh: options?.refresh });
        return {
          models: authed && providerId === "claude" ? liveClaudeModels : [],
          source: authed ? "providerCatalog" : "bundledCatalog",
          providerId: providerId ?? "muse",
          profileId: "default",
          hostVersion: "2.1.310",
        };
      },
      listModels: async () => liveClaudeModels,
    } as unknown) as AncillaClient;

    const controller = new AncillaController(client, platform);
    try {
      await controller.beginProviderLogin("claude", null);
      assert.equal(controller.store.get().providerLogin?.status, "waiting");
      assert.equal(controller.store.get().providerLogin?.needsCodeInput, true);

      const ok = await controller.submitProviderLoginCode("  my_oauth_code#st1  ");
      assert.equal(ok, true);
      assert.deepEqual(submittedCodes, [
        { providerId: "claude", loginId: "login-claude-1", code: "my_oauth_code#st1", accountId: null },
      ]);
      assert.equal(controller.store.get().providerLogin?.status, "done");

      await new Promise((r) => setTimeout(r, 20));
      assert.ok(
        catalogCalls.some((c) => c.providerId === "claude" && c.refresh === true),
        "must force-refresh Claude's live model catalog upon login completion",
      );
      assert.deepEqual(
        (controller.store.get().accountModels["prov:claude:default"] ?? []).map((m) => m.modelId),
        ["opus", "fable[1m]"],
      );
    } finally {
      controller.dispose();
    }
  });
});

describe("ModelPick one-click sign-in, Home provider card scoping, and uncached pre-login Claude catalog", () => {
  it("renders a one-click Sign in to Claude Code button inside ModelPick when Claude is unauthenticated", () => {
    const html = renderWithState(
      ModelPick,
      {
        value: null,
        onChange: () => {},
        full: true,
        scope: { providerId: "claude", accountId: null },
      },
      {
        providers: [makeClaudeProviderView(false)],
        accountModels: { "prov:claude:default": [] },
        modelsStatus: {
          "prov:claude:default": {
            status: "ready",
            error: null,
            loadedAt: 1000,
            catalog: { source: "bundledCatalog", providerId: "claude", profileId: "default", hostVersion: "2.1.310" },
          },
        },
      },
    );
    assert.ok(html.includes("Sign in to Claude Code"));
  });

  it("hides Meta Muse sign-in banner on NewThread when project defaultProviderId is Claude or Codex", () => {
    const html = renderWithState(
      NewThread,
      { cwd: "/work/app" },
      {
        defaultLogin: { hasLogin: false, email: null },
        metaApiKeyInherited: false,
        projects: [
          {
            cwd: "/work/app",
            displayName: "app",
            pinned: false,
            activityAt: "2026-11-12T00:00:00.000Z",
            folders: [{ cwd: "/work/app", displayName: "app" }],
            defaultProviderId: "claude",
            defaultAccountId: null,
          },
        ],
        providers: [makeClaudeProviderView(true)],
      },
    );
    assert.ok(!html.includes("Sign in with Meta"), "Muse onboarding card must not appear when project uses Claude Code");
  });
});
