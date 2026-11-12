import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ControllerProvider } from "../src/app/context.js";
import type { AncillaClient } from "../src/client.js";
import { ProfilePanel } from "../src/components/assistant/ProfilePanel.js";
import {
  buildProviderAccountOptions,
  ModelPick,
  Pick,
  SettingsPage,
} from "../src/components/settings/SettingsPage.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import { VoicePanel } from "../src/components/voice/VoicePanel.js";
import { AncillaController, type Platform } from "../src/model/controller.js";
import { modelStub } from "../src/model/models.js";
import {
  defaultModelForScope,
  defaultPrefs,
  initialState,
  patchDefaultModelForScope,
  providerKeyForScope,
  Store,
  type AppState,
  type Prefs,
} from "../src/model/store.js";
import type {
  AccountView,
  AssistantProfileView,
  ModelCatalog,
  ModelOption,
  ProviderCapabilities,
  ProviderId,
  ProviderView,
  VoiceBrainSetting,
  VoiceSettingsView,
  VoiceStatusView,
} from "../src/types.js";

// ============================================================================
// Test Utilities & Mocks
// ============================================================================

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

function mockAccount(id: string, name: string, email = "user@example.com"): AccountView {
  return { id, name, hasLogin: true, email, lastUsedAt: null };
}

function mockApiAccount(id: string, name: string, apiBaseUrl = "https://api.example.com/v1") {
  return {
    id,
    providerId: "api" as ProviderId,
    name,
    runtimeOverride: null,
    binaryPath: null,
    customArgs: [],
    apiKind: "openai" as const,
    apiBaseUrl,
    hasApiKey: true,
    stripAmbientKeys: false,
    defaultModelId: null,
    customModels: [],
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
}

function mockProvider(
  id: ProviderId,
  displayName: string,
  available: boolean,
  accounts: any[] = [],
): ProviderView {
  return {
    id,
    displayName,
    vendorName: displayName,
    subscriptionSummary: "Active",
    binaryName: id,
    serveArgs: [],
    loginArgs: null,
    installDocsUrl: null,
    usageDashboardUrl: null,
    capabilities: CAPS,
    binary: {
      providerId: id,
      available,
      runtime: "native",
      binaryPath: available ? `/usr/bin/${id}` : null,
      distro: null,
      version: "1.0",
    },
    ambientKeyOverrides: [],
    defaultAuth: { state: "authenticated", summary: "Active", email: null, planTier: null, authMethod: null },
    accounts,
  };
}

function mockPlatform(hash = ""): Platform & { hash: string; savedPrefs: Prefs | null } {
  const p = {
    hash,
    savedPrefs: null as Prefs | null,
    loadPrefs: () => p.savedPrefs,
    savePrefs: (next: Prefs) => {
      p.savedPrefs = next;
    },
    readHash: () => p.hash,
    writeHash: (next: string) => {
      p.hash = next;
    },
    onHashChange: () => () => {},
    now: () => Date.now(),
    schedule: (fn: () => void) => setTimeout(fn, 0),
    cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    focused: () => true,
  };
  return p;
}

class MockAncillaClient {
  models: ModelOption[] = [];
  modelSource: string | null = "providerCatalog";
  catalogCalls: {
    sessionId?: string;
    accountId?: string | null;
    providerId?: ProviderId | null;
    options?: { refresh?: boolean };
  }[] = [];
  voiceCalls: { method: string; path: string; body: unknown }[] = [];
  assistantCalls: { method: string; path: string; body: unknown }[] = [];

  async listModels(
    sessionId?: string,
    accountId?: string | null,
    providerId?: ProviderId | null,
    options?: { refresh?: boolean },
  ): Promise<ModelOption[]> {
    const catalog = await this.listModelCatalog(sessionId, accountId, providerId, options);
    return catalog.models;
  }

  async listModelCatalog(
    sessionId?: string,
    accountId?: string | null,
    providerId?: ProviderId | null,
    options?: { refresh?: boolean },
  ): Promise<ModelCatalog> {
    this.catalogCalls.push({ sessionId, accountId, providerId, options });
    return {
      models: this.models,
      source: this.modelSource,
      providerId: providerId ?? "meta",
      profileId: accountId ?? "default",
      hostVersion: "1.4.7",
    };
  }

  async voice<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    this.voiceCalls.push({ method, path, body });
    if (path === "") {
      return {
        available: true,
        pack: { runtime: true, vad: true, streaming: true, refine: true, tts: true, ready: true, missing: [] },
        layout: { runtimeDir: null, modelsDir: "" },
        engines: { loaded: true, asr: null, tts: null, sampleRate: null },
        call: { active: false, id: null, conversation: null, since: null },
        settings: {
          mode: "hands-free",
          voice: null,
          speed: 1,
          refine: true,
          ttsSteps: 5,
          brain: { kind: "muse", model: null, accountId: null },
          speech: { kind: "local" },
          proactive: false,
          keepDays: null,
          runtimeDir: null,
          modelsDir: null,
          defaultProject: null,
          hasKey: false,
          hasSpeechKey: false,
        },
        brain: { label: "Muse", local: false, problem: null },
        voices: [],
        latency: { turns: 0, firstAudio: { n: 0, p50: null, p95: null }, endpoint: { n: 0, p50: null, p95: null } },
      } as unknown as T;
    }
    return { ok: true } as unknown as T;
  }

  async assistant<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    this.assistantCalls.push({ method, path, body });
    if (path === "/goals") return { goals: [] } as unknown as T;
    if (path === "") {
      return {
        profile: {
          id: "default",
          enabled: true,
          name: "Assistant",
          persona: "Helpful",
          character: {
            avatar: { form: "halo", hue: 0, glow: 0, detail: 0, seed: 0 },
            voice: { archetype: "steady", warmth: 0, humor: 0, directness: 0, curiosity: 0, formality: 0 },
            callsUser: "User",
            quirks: [],
            presence: "off",
            showBond: false,
            setupAt: null,
          },
          communication: { verbosity: "balanced", tone: "plain", language: "en", notes: "" },
          autonomy: "suggest",
          policy: {
            allowReadOnly: true,
            allowProjectWrites: false,
            maxConcurrent: 2,
            maxTurnsPerTask: 10,
            maxMinutesPerTask: 30,
            maxTasksPerDay: 20,
          },
          model: { providerId: null, accountId: null, modelId: null },
          capturePaused: false,
          contextBudgetTokens: 1000,
          updatedAt: 1000,
        },
      } as unknown as T;
    }
    return { ok: true } as unknown as T;
  }

  async getTitleSettings() {
    return { enabled: true, modelId: null };
  }
}

function renderInContext<P extends object>(
  Component: ComponentType<P>,
  props: P,
  controller: AncillaController,
): string {
  return renderToStaticMarkup(
    createElement(ControllerProvider, {
      controller,
      children: createElement(TooltipProvider, {
        children: createElement(Component, props),
      }),
    }),
  );
}

function pressed(html: string, label: string): boolean {
  return html.includes(`aria-pressed="true"`) && html.includes(label);
}

// ============================================================================
// Full Roster Mock Providers & Accounts
// ============================================================================

const ROSTER_ACCOUNTS: AccountView[] = [
  mockAccount("muse-corp", "Corporate Muse", "dev@corp.com"),
  mockAccount("muse-personal", "Personal Muse", "dev@home.org"),
];

const ROSTER_PROVIDERS: ProviderView[] = [
  mockProvider("muse", "Meta Muse", true, []),
  mockProvider("codex", "OpenAI Codex", true, [
    {
      id: "work",
      providerId: "codex",
      name: "Work Codex",
      runtimeOverride: null,
      binaryPath: null,
      customArgs: [],
      apiKind: null,
      apiBaseUrl: null,
      hasApiKey: false,
      stripAmbientKeys: false,
      defaultModelId: null,
      customModels: [],
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      auth: { state: "authenticated", summary: "Work subscription", email: null, planTier: null, authMethod: null },
    },
    {
      id: "personal",
      providerId: "codex",
      name: "Personal Codex",
      runtimeOverride: null,
      binaryPath: null,
      customArgs: [],
      apiKind: null,
      apiBaseUrl: null,
      hasApiKey: false,
      stripAmbientKeys: false,
      defaultModelId: null,
      customModels: [],
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      auth: { state: "authenticated", summary: "Personal tier", email: null, planTier: null, authMethod: null },
    },
  ]),
  mockProvider("claude", "Anthropic Claude", true, [
    {
      id: "enterprise",
      providerId: "claude",
      name: "Enterprise Claude",
      runtimeOverride: null,
      binaryPath: null,
      customArgs: [],
      apiKind: null,
      apiBaseUrl: null,
      hasApiKey: false,
      stripAmbientKeys: false,
      defaultModelId: null,
      customModels: [],
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      auth: { state: "authenticated", summary: "Team plan", email: null, planTier: null, authMethod: null },
    },
  ]),
  mockProvider("gemini", "Google Gemini", true, []),
  mockProvider("copilot", "GitHub Copilot", true, []),
  mockProvider("kimi", "Moonshot Kimi", true, []),
  mockProvider("qwen", "Alibaba Qwen", true, []),
  mockProvider("opencode", "OpenCode", true, []),
  mockProvider("api", "API", false, [
    mockApiAccount("openrouter", "OpenRouter Hub", "https://openrouter.ai/api/v1"),
    mockApiAccount("groq", "Groq Fast", "https://api.groq.com/openai/v1"),
    mockApiAccount("together", "Together AI", "https://api.together.xyz/v1"),
  ]),
];

// ============================================================================
// STRESS TEST SUITE
// ============================================================================

describe("Challenger M3 Empirical Adversarial Stress Suite", () => {
  // --------------------------------------------------------------------------
  // 1. Tri-Modal Segregation Invariant Test Under High-Volume Interleaved Stress
  // --------------------------------------------------------------------------
  describe("1. Tri-Modal Segregation Invariant Stress", () => {
    it("Tri-Modal Invariant: Interleaved mutations maintain 100% isolation across Chat, Assistant, and Voice", async () => {
      const client = new MockAncillaClient();
      const p = mockPlatform();
      const controller = new AncillaController(client as unknown as AncillaClient, p);

      // Hydrate state with full roster
      controller.store.set((s) => ({
        ...s,
        accounts: ROSTER_ACCOUNTS,
        providers: ROSTER_PROVIDERS,
      }));

      // Expected reference states
      const expectedChatDefaults: Record<string, string | null> = {
        muse: null,
        "muse:muse-corp": null,
        codex: null,
        "codex:work": null,
        "codex:personal": null,
        claude: null,
        "claude:enterprise": null,
        gemini: null,
        copilot: null,
        kimi: null,
        qwen: null,
        opencode: null,
        "api:openrouter": null,
        "api:groq": null,
        "api:together": null,
      };

      let expectedAssistantModel: {
        providerId: ProviderId | null;
        accountId: string | null;
        modelId: string | null;
      } = { providerId: null, accountId: null, modelId: null };

      let expectedVoiceBrain: VoiceBrainSetting = { kind: "none" };

      // Helper to verify invariants across all 3 domains
      const assertInvariants = (stepLabel: string) => {
        const prefs = controller.store.get().prefs;

        // Verify Muse chat default
        const museChat = defaultModelForScope(prefs, { providerId: "muse" });
        assert.equal(
          museChat.modelId,
          expectedChatDefaults["muse"],
          `[${stepLabel}] Chat muse model mismatch`,
        );

        // Verify all non-muse chat defaults
        for (const [key, expectedModel] of Object.entries(expectedChatDefaults)) {
          if (key === "muse") continue;
          const [providerId, accountId] = key.split(":") as [ProviderId, string | undefined];
          const result = defaultModelForScope(prefs, { providerId, accountId: accountId ?? null });
          assert.equal(
            result.modelId,
            expectedModel,
            `[${stepLabel}] Chat default mismatch for ${key}`,
          );
        }

        // Verify Assistant calls
        if (client.assistantCalls.length > 0) {
          const lastAssistantCall = client.assistantCalls[client.assistantCalls.length - 1];
          assert.equal(lastAssistantCall?.method, "PATCH");
          assert.equal(lastAssistantCall?.path, "/profile");
          assert.deepEqual(
            (lastAssistantCall?.body as any)?.model,
            expectedAssistantModel,
            `[${stepLabel}] Assistant payload mismatch`,
          );
        }

        // Verify Voice calls
        if (client.voiceCalls.length > 0) {
          const lastVoiceCall = client.voiceCalls[client.voiceCalls.length - 1];
          assert.equal(lastVoiceCall?.method, "PATCH");
          assert.equal(lastVoiceCall?.path, "/settings");
          assert.deepEqual(
            (lastVoiceCall?.body as any)?.brain,
            expectedVoiceBrain,
            `[${stepLabel}] Voice brain payload mismatch`,
          );
        }
      };

      // Initial invariant check
      assertInvariants("Initial");

      // Execution of interleaved operations:
      const operations = [
        // Step 1: Set Muse Chat default (all Muse scopes share defaultModelId by design)
        () => {
          controller.setDefaultModelForScope({ providerId: "muse" }, "muse-ember-1.0");
          expectedChatDefaults["muse"] = "muse-ember-1.0";
          expectedChatDefaults["muse:muse-corp"] = "muse-ember-1.0";
        },
        // Step 2: Set Assistant model to Follow Project
        async () => {
          expectedAssistantModel = { providerId: null, accountId: null, modelId: null };
          await controller.assistant("PATCH", "/profile", { model: expectedAssistantModel });
        },
        // Step 3: Set Voice Brain to none
        async () => {
          expectedVoiceBrain = { kind: "none" };
          await controller.voice("PATCH", "/settings", { brain: expectedVoiceBrain });
        },
        // Step 4: Set Codex Chat default
        () => {
          controller.setDefaultModelForScope({ providerId: "codex" }, "o3-mini");
          expectedChatDefaults["codex"] = "o3-mini";
        },
        // Step 5: Set Codex Work account Chat default
        () => {
          controller.setDefaultModelForScope(
            { providerId: "codex", accountId: "work" },
            "codex-work-standard",
          );
          expectedChatDefaults["codex:work"] = "codex-work-standard";
        },
        // Step 6: Set Assistant model to Codex Personal
        async () => {
          expectedAssistantModel = {
            providerId: "codex",
            accountId: "personal",
            modelId: "o3-mini-personal",
          };
          await controller.assistant("PATCH", "/profile", { model: expectedAssistantModel });
        },
        // Step 7: Set Voice Brain to Muse
        async () => {
          expectedVoiceBrain = { kind: "muse", model: "muse-spark-1.3", accountId: null };
          await controller.voice("PATCH", "/settings", { brain: expectedVoiceBrain });
        },
        // Step 8: Set Claude Enterprise Chat default
        () => {
          controller.setDefaultModelForScope(
            { providerId: "claude", accountId: "enterprise" },
            "claude-3-5-sonnet",
          );
          expectedChatDefaults["claude:enterprise"] = "claude-3-5-sonnet";
        },
        // Step 9: Set Gemini Chat default
        () => {
          controller.setDefaultModelForScope({ providerId: "gemini" }, "gemini-2.5-pro");
          expectedChatDefaults["gemini"] = "gemini-2.5-pro";
        },
        // Step 10: Set Voice Brain to Provider (Copilot)
        async () => {
          expectedVoiceBrain = {
            kind: "provider",
            providerId: "copilot",
            accountId: null,
            model: "copilot-claude-3.5",
          };
          await controller.voice("PATCH", "/settings", { brain: expectedVoiceBrain });
        },
        // Step 11: Set Assistant model to API OpenRouter
        async () => {
          expectedAssistantModel = {
            providerId: "api",
            accountId: "openrouter",
            modelId: "deepseek/deepseek-r1",
          };
          await controller.assistant("PATCH", "/profile", { model: expectedAssistantModel });
        },
        // Step 12: Set API Groq Chat default
        () => {
          controller.setDefaultModelForScope(
            { providerId: "api", accountId: "groq" },
            "llama-3.3-70b",
          );
          expectedChatDefaults["api:groq"] = "llama-3.3-70b";
        },
        // Step 13: Set Voice Brain to Custom Endpoint
        async () => {
          expectedVoiceBrain = {
            kind: "openai",
            baseUrl: "http://localhost:11434/v1",
            model: "qwen2.5-coder:32b",
            local: true,
            label: null,
            apiKeyEnv: null,
          };
          await controller.voice("PATCH", "/settings", { brain: expectedVoiceBrain });
        },
        // Step 14: Clear Codex Chat default (set to null)
        () => {
          controller.setDefaultModelForScope({ providerId: "codex" }, null);
          expectedChatDefaults["codex"] = null;
        },
        // Step 15: Clear Assistant model (reset to project)
        async () => {
          expectedAssistantModel = { providerId: null, accountId: null, modelId: null };
          await controller.assistant("PATCH", "/profile", { model: expectedAssistantModel });
        },
        // Step 16: Clear Voice Brain (set to none)
        async () => {
          expectedVoiceBrain = { kind: "none" };
          await controller.voice("PATCH", "/settings", { brain: expectedVoiceBrain });
        },
      ];

      for (let i = 0; i < operations.length; i++) {
        await operations[i]();
        assertInvariants(`Step ${i + 1}`);
      }

      // Final cross-check:
      // Check that Chat Muse default is still muse-ember-1.0
      assert.equal(
        defaultModelForScope(controller.store.get().prefs, { providerId: "muse" }).modelId,
        "muse-ember-1.0",
      );
      // Check that Codex work is still codex-work-standard
      assert.equal(
        defaultModelForScope(controller.store.get().prefs, { providerId: "codex", accountId: "work" }).modelId,
        "codex-work-standard",
      );
      // Check that Codex general was cleared to null
      assert.equal(
        defaultModelForScope(controller.store.get().prefs, { providerId: "codex" }).modelId,
        null,
      );
      // Check that Groq API chat default is still llama-3.3-70b
      assert.equal(
        defaultModelForScope(controller.store.get().prefs, { providerId: "api", accountId: "groq" }).modelId,
        "llama-3.3-70b",
      );
    });
  });

  // --------------------------------------------------------------------------
  // 2. Multi-Provider & Multi-Account Options Builder Stress
  // --------------------------------------------------------------------------
  describe("2. Multi-Provider & Multi-Account Options Builder Stress", () => {
    it("buildProviderAccountOptions accurately generates all 9 providers + accounts without collision", () => {
      const options = buildProviderAccountOptions(ROSTER_ACCOUNTS, ROSTER_PROVIDERS, {
        includeFollowProject: true,
        includeCustom: true,
        includeNone: true,
        customLabel: "Custom endpoint",
      });

      const values = options.map((o) => o.value);
      // Assert zero duplicate values
      const uniqueValues = new Set(values);
      assert.equal(values.length, uniqueValues.size, "Option values must be strictly unique");

      // Verify essential expected values exist
      assert.ok(values.includes("project"), "Must include project");
      assert.ok(values.includes("muse::"), "Must include muse default");
      assert.ok(values.includes("muse::muse-corp"), "Must include muse corp");
      assert.ok(values.includes("muse::muse-personal"), "Must include muse personal");
      assert.ok(values.includes("codex::"), "Must include codex default");
      assert.ok(values.includes("codex::work"), "Must include codex work");
      assert.ok(values.includes("codex::personal"), "Must include codex personal");
      assert.ok(values.includes("claude::"), "Must include claude default");
      assert.ok(values.includes("claude::enterprise"), "Must include claude enterprise");
      assert.ok(values.includes("gemini::"), "Must include gemini");
      assert.ok(values.includes("copilot::"), "Must include copilot");
      assert.ok(values.includes("kimi::"), "Must include kimi");
      assert.ok(values.includes("qwen::"), "Must include qwen");
      assert.ok(values.includes("opencode::"), "Must include opencode");
      assert.ok(values.includes("api::openrouter"), "Must include api:openrouter");
      assert.ok(values.includes("api::groq"), "Must include api:groq");
      assert.ok(values.includes("api::together"), "Must include api:together");
      assert.ok(values.includes("custom"), "Must include custom");
      assert.ok(values.includes("none"), "Must include none");

      // Verify custom label
      const customOpt = options.find((o) => o.value === "custom");
      assert.equal(customOpt?.label, "Custom endpoint");
    });

    it("buildProviderAccountOptions handles null and empty edge cases gracefully", () => {
      const nullOptions = buildProviderAccountOptions(null, null);
      assert.equal(nullOptions.length, 1);
      assert.equal(nullOptions[0]?.value, "muse::");

      const emptyOptions = buildProviderAccountOptions([], []);
      assert.equal(emptyOptions.length, 1);
      assert.equal(emptyOptions[0]?.value, "muse::");

      // Alt provider without binary and without accounts is omitted
      const deadProvider = mockProvider("codex", "OpenAI Codex", false, []);
      const deadOptions = buildProviderAccountOptions([], [deadProvider]);
      assert.equal(deadOptions.some((o) => o.value.startsWith("codex")), false);

      // API provider with 0 accounts is omitted
      const emptyApiProvider = mockProvider("api", "API", false, []);
      const apiOptions = buildProviderAccountOptions([], [emptyApiProvider]);
      assert.equal(apiOptions.some((o) => o.value.startsWith("api")), false);
    });
  });

  // --------------------------------------------------------------------------
  // 3. ProfilePanel Empirical Stress
  // --------------------------------------------------------------------------
  describe("3. ProfilePanel Empirical Stress", () => {
    const baseProfile: AssistantProfileView = {
      id: "prof-test",
      enabled: true,
      name: "Assistant",
      persona: "Tester",
      character: {
        avatar: { form: "halo", hue: 0, glow: 0, detail: 0, seed: 0 },
        voice: { archetype: "steady", warmth: 0, humor: 0, directness: 0, curiosity: 0, formality: 0 },
        callsUser: "User",
        quirks: [],
        presence: "off",
        showBond: false,
        setupAt: null,
      },
      communication: { verbosity: "balanced", tone: "plain", language: "en", notes: "" },
      autonomy: "suggest",
      policy: {
        allowReadOnly: true,
        allowProjectWrites: false,
        maxConcurrent: 2,
        maxTurnsPerTask: 10,
        maxMinutesPerTask: 30,
        maxTasksPerDay: 20,
      },
      model: { providerId: null, accountId: null, modelId: null },
      capturePaused: false,
      contextBudgetTokens: 1000,
      updatedAt: 1234567,
    };

    it("ProfilePanel renders Follow project as selected when model is null or providerId is null", () => {
      const client = new MockAncillaClient();
      const controller = new AncillaController(client as unknown as AncillaClient, mockPlatform());
      controller.store.set((s) => ({
        ...s,
        accounts: ROSTER_ACCOUNTS,
        providers: ROSTER_PROVIDERS,
      }));

      const html = renderInContext(
        ProfilePanel,
        { profile: baseProfile, changed: () => {}, bump: 0 },
        controller,
      );

      assert.ok(html.includes("Model for assistant tasks"));
      assert.ok(html.includes("Task provider &amp; account") || html.includes("Task provider & account"));
      assert.ok(pressed(html, "Follow project"));
      // When Follow project is selected, "Task model" row must NOT be rendered
      assert.ok(!html.includes("Task model"));
    });

    it("ProfilePanel renders Task model row when a provider is selected", () => {
      const client = new MockAncillaClient();
      const controller = new AncillaController(client as unknown as AncillaClient, mockPlatform());
      controller.store.set((s) => ({
        ...s,
        accounts: ROSTER_ACCOUNTS,
        providers: ROSTER_PROVIDERS,
      }));

      const codexProfile: AssistantProfileView = {
        ...baseProfile,
        model: { providerId: "codex", accountId: "work", modelId: "o3-mini" },
      };

      const html = renderInContext(
        ProfilePanel,
        { profile: codexProfile, changed: () => {}, bump: 0 },
        controller,
      );

      assert.ok(html.includes("Task model"));
      assert.ok(html.includes("Work Codex") || html.includes("Codex"));
    });

    it("ProfilePanel gracefully handles unknown provider without crashing by synthesizing option", () => {
      const client = new MockAncillaClient();
      const controller = new AncillaController(client as unknown as AncillaClient, mockPlatform());
      controller.store.set((s) => ({
        ...s,
        accounts: [],
        providers: [],
      }));

      const foreignProfile: AssistantProfileView = {
        ...baseProfile,
        model: { providerId: "kimi", accountId: null, modelId: "moonshot-v1-8k" },
      };

      // Must not throw even though 'kimi' is not in active accounts/providers
      const html = renderInContext(
        ProfilePanel,
        { profile: foreignProfile, changed: () => {}, bump: 0 },
        controller,
      );

      assert.ok(html.includes("Model for assistant tasks"));
      assert.ok(html.includes("Task model"));
    });
  });

  // --------------------------------------------------------------------------
  // 4. VoicePanel Empirical Stress
  // --------------------------------------------------------------------------
  describe("4. VoicePanel Empirical Stress", () => {
    it("VoicePanel renders 'This version of Ancilla has no voice' when controller.hasVoice is false", () => {
      const client = new MockAncillaClient();
      const controller = new AncillaController(client as unknown as AncillaClient, mockPlatform());
      Object.defineProperty(controller, "hasVoice", { get: () => false });

      const html = renderInContext(
        VoicePanel,
        { changed: () => {} },
        controller,
      );

      assert.ok(html.includes("This version of Ancilla has no voice."));
      assert.ok(!html.includes("The model that answers"));
    });

    it("VoicePanel falls back safely to DEFAULT_VOICE_STATUS on null status without crash", () => {
      const client = new MockAncillaClient();
      const controller = new AncillaController(client as unknown as AncillaClient, mockPlatform());
      Object.defineProperty(controller, "hasVoice", { get: () => true });

      const html = renderInContext(
        VoicePanel,
        { changed: () => {}, status: null },
        controller,
      );

      assert.ok(html.includes("The model that answers"));
      assert.ok(html.includes("Voice engines"));
    });

    it("VoicePanel renders Custom endpoint view with protocol, address, and model fields when kind is openai", () => {
      const client = new MockAncillaClient();
      const controller = new AncillaController(client as unknown as AncillaClient, mockPlatform());
      Object.defineProperty(controller, "hasVoice", { get: () => true });

      const customStatus: VoiceStatusView = {
        available: true,
        pack: { runtime: true, vad: true, streaming: true, refine: true, tts: true, ready: true, missing: [] },
        layout: { runtimeDir: null, modelsDir: "" },
        engines: { loaded: true, asr: null, tts: null, sampleRate: null },
        call: { active: false, id: null, conversation: null, since: null },
        settings: {
          mode: "hands-free",
          voice: null,
          speed: 1,
          refine: true,
          ttsSteps: 5,
          brain: {
            kind: "openai",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
            local: false,
            label: null,
            apiKeyEnv: null,
          },
          speech: { kind: "local" },
          proactive: false,
          keepDays: null,
          runtimeDir: null,
          modelsDir: null,
          defaultProject: null,
          hasKey: false,
          hasSpeechKey: false,
        },
        brain: { label: "OpenAI", local: false, problem: null },
        voices: [],
        latency: { turns: 0, firstAudio: { n: 0, p50: null, p95: null }, endpoint: { n: 0, p50: null, p95: null } },
      };

      const html = renderInContext(
        VoicePanel,
        { changed: () => {}, status: customStatus },
        controller,
      );

      assert.ok(html.includes("The model that answers"));
      assert.ok(html.includes("Protocol"));
      assert.ok(html.includes("Address"));
      assert.ok(html.includes("Model name"));
      assert.ok(pressed(html, "Custom endpoint"));
    });

    it("VoicePanel renders None choice when brain kind is none", () => {
      const client = new MockAncillaClient();
      const controller = new AncillaController(client as unknown as AncillaClient, mockPlatform());
      Object.defineProperty(controller, "hasVoice", { get: () => true });

      const noneStatus: VoiceStatusView = {
        available: true,
        pack: { runtime: true, vad: true, streaming: true, refine: true, tts: true, ready: true, missing: [] },
        layout: { runtimeDir: null, modelsDir: "" },
        engines: { loaded: true, asr: null, tts: null, sampleRate: null },
        call: { active: false, id: null, conversation: null, since: null },
        settings: {
          mode: "hands-free",
          voice: null,
          speed: 1,
          refine: true,
          ttsSteps: 5,
          brain: { kind: "none" },
          speech: { kind: "local" },
          proactive: false,
          keepDays: null,
          runtimeDir: null,
          modelsDir: null,
          defaultProject: null,
          hasKey: false,
          hasSpeechKey: false,
        },
        brain: { label: "None", local: false, problem: null },
        voices: [],
        latency: { turns: 0, firstAudio: { n: 0, p50: null, p95: null }, endpoint: { n: 0, p50: null, p95: null } },
      };

      const html = renderInContext(
        VoicePanel,
        { changed: () => {}, status: noneStatus },
        controller,
      );

      assert.ok(html.includes("The model that answers"));
      assert.ok(pressed(html, "None"));
    });
  });

  // --------------------------------------------------------------------------
  // 5. SettingsPage Tri-Modal Integration Stress
  // --------------------------------------------------------------------------
  describe("5. SettingsPage Tri-Modal Integration Stress", () => {
    it("SettingsPage renders Chat, Assistant, and Voice selectors concurrently without conflict", () => {
      const client = new MockAncillaClient();
      const controller = new AncillaController(client as unknown as AncillaClient, mockPlatform());
      Object.defineProperty(controller, "hasVoice", { get: () => true });

      controller.store.set((s) => ({
        ...s,
        accounts: ROSTER_ACCOUNTS,
        providers: ROSTER_PROVIDERS,
      }));

      const html = renderInContext(SettingsPage, {}, controller);

      // Section 1: New threads (Chat)
      assert.ok(html.includes("New threads"), "Must render New threads");
      assert.ok(html.includes("Provider &amp; account") || html.includes("Provider & account"), "Must render chat Provider & account");

      // Section 2: Assistant (Assistant Task + Voice)
      assert.ok(html.includes("Assistant"), "Must render Assistant section");
      assert.ok(html.includes("Task provider &amp; account") || html.includes("Task provider & account"), "Must render Task provider & account");
      assert.ok(html.includes("Voice &amp; web provider") || html.includes("Voice & web provider"), "Must render Voice & web provider");
    });
  });
});
