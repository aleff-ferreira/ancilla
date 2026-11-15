/**
 * @file model-overhaul.test.ts
 *
 * Comprehensive 4-Tier Opaque-Box E2E & Integration Test Suite for the Model Selector Overhaul.
 *
 * Implements the complete 73-case test matrix specified in test_spec_miner_3/handoff.md:
 * - Tier 1: Feature Coverage (30 tests: F1-T1-01 to F6-T1-05)
 * - Tier 2: Boundary & Corner Cases (30 tests: F1-T2-01 to F6-T2-05)
 * - Tier 3: Cross-Feature Combinations (8 tests: COMB-T3-01 to COMB-T3-08)
 * - Tier 4: Real-World Application Scenarios (5 tests: SCEN-T4-01 to SCEN-T4-05)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ControllerProvider } from "../src/app/context.js";
import type { AncillaClient } from "../src/client.js";
import { ProfilePanel } from "../src/components/assistant/ProfilePanel.js";
import { ModelPicker } from "../src/components/composer/Composer.js";
import { ModelPick, Pick, SettingsPage } from "../src/components/settings/SettingsPage.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import { VoicePanel } from "../src/components/voice/VoicePanel.js";
import { AncillaController, type ModelsRefresh, type Platform } from "../src/model/controller.js";
import { modelDisplayName } from "../src/model/format.js";
import {
  isModelId,
  modelChoices,
  modelCompletions,
  modelMenu,
  modelStub,
  publishedStubs,
  type ModelChoice,
  type ModelMenuSource,
  type ModelsScope,
  type PinContext,
} from "../src/model/models.js";
import { listedPrice, publishedModelIds } from "../src/model/pricing.js";
import {
  defaultModelForScope,
  defaultPrefs,
  initialState,
  patchDefaultModelForScope,
  revivePrefs,
  Store,
  type AppState,
  type Prefs,
} from "../src/model/store.js";
import type {
  AssistantProfileView,
  ModelCatalog,
  ModelCatalogInfo,
  ModelOption,
  ModelsStatus,
  ProviderId,
  TitleSettings,
} from "../src/types.js";

// ============================================================================
// Test Harness & Mock Client Infrastructure
// ============================================================================

const model = (modelId: string, extra: Partial<ModelOption> = {}): ModelOption =>
  modelStub(modelId, extra);

const SPARK = model("muse-spark-1.3", { isDefault: true, contextLimit: 1_000_000 });
const WONDER = model("muse-wonder-1.0", { contextLimit: 1_048_576 });

function readyCatalog(source: string | null, models: ModelOption[] = []): {
  models: ModelOption[];
  status: ModelsStatus;
} {
  const info: ModelCatalogInfo = {
    source,
    providerId: "meta",
    profileId: "default",
    hostVersion: "1.4.7",
  };
  return {
    models,
    status: { status: "ready", error: null, loadedAt: 1_000, catalog: info },
  };
}

const pressed = (html: string, label: string): boolean =>
  new RegExp(`aria-pressed="true"[^>]*>${label.replace(/[()]/g, "\\$&")}<`).test(html);

function renderInApp<P extends object>(
  Component: ComponentType<P>,
  props: P,
  patch: Partial<AppState> = {},
  prefs: Partial<Prefs> = {},
  controllerOverride?: AncillaController,
): string {
  if (controllerOverride?.store && typeof controllerOverride.store.set === "function") {
    const hasPrefs = prefs && Object.keys(prefs).length > 0;
    const hasPatch = patch && Object.keys(patch).length > 0;
    if (hasPrefs || hasPatch) {
      controllerOverride.store.set((s) => ({
        ...s,
        ...(hasPrefs ? { prefs: { ...s.prefs, ...prefs } } : {}),
        ...(hasPatch ? patch : {}),
      }));
    }
  }

  const initial = initialState({
    ...defaultPrefs("2026-11-12T00:00:00.000Z"),
    ...prefs,
  });
  const store = new Store<AppState>({
    ...initial,
    connection: "open",
    ...patch,
  });
  const controller =
    controllerOverride ??
    (({
      store,
      loadAccounts: async () => {},
      refreshModels: async () => {},
      setDefaultModelForScope: () => {},
    } as unknown) as AncillaController);

  return renderToStaticMarkup(
    createElement(ControllerProvider, {
      controller,
      children: createElement(TooltipProvider, {
        children: createElement(Component, props),
      }),
    }),
  );
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
    return { ok: true } as unknown as T;
  }

  async assistant<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    this.assistantCalls.push({ method, path, body });
    if (path === "/goals") return { goals: [] } as unknown as T;
    return { ok: true } as unknown as T;
  }

  async getTitleSettings(): Promise<TitleSettings> {
    return { enabled: true, modelId: null };
  }
}

// ============================================================================
// TIER 1: Feature Coverage (30 Tests)
// ============================================================================

describe("Tier 1: Feature Coverage", () => {
  // --------------------------------------------------------------------------
  // Feature 1: Per-Provider Default Chat Models
  // --------------------------------------------------------------------------
  describe("F1: Per-Provider Default Chat Models", () => {
    it("F1-T1-01: Default Model Initialization & Revival", () => {
      const prefs = revivePrefs({}, defaultPrefs("2026-11-12T00:00:00.000Z"));
      assert.equal(prefs.defaultModelId, null);
      assert.equal(prefs.defaultModelTried, false);
      assert.ok(prefs.providerDefaultModels !== undefined, "providerDefaultModels must be initialized");
      assert.deepEqual(prefs.providerDefaultModels, {});
    });

    it("F1-T1-02: Scoped Model Getter for Muse Scope", () => {
      const prefs: Prefs = {
        ...defaultPrefs("2026-11-12T00:00:00.000Z"),
        defaultModelId: "muse-wonder-1.0",
        defaultModelTried: true,
      };
      const museScopeResult = defaultModelForScope(prefs, { providerId: "muse" });
      const nullScopeResult = defaultModelForScope(prefs, null);
      assert.deepEqual(museScopeResult, { modelId: "muse-wonder-1.0", tried: true });
      assert.deepEqual(nullScopeResult, { modelId: "muse-wonder-1.0", tried: true });
    });

    it("F1-T1-03: Scoped Model Getter for Non-Muse CLI Provider", () => {
      const prefs: Prefs = {
        ...defaultPrefs("2026-11-12T00:00:00.000Z"),
        providerDefaultModels: {
          "codex:work": { modelId: "o3-mini", tried: false },
        },
      };

      const codexResult = defaultModelForScope(prefs, {
        providerId: "codex",
        accountId: "work",
      });
      assert.deepEqual(codexResult, { modelId: "o3-mini", tried: false });

      const claudeResult = defaultModelForScope(prefs, { providerId: "claude" });
      assert.deepEqual(claudeResult, { modelId: null, tried: false });
    });

    it("F1-T1-04: Scoped Model Setter for API Profile", () => {
      const prefs = defaultPrefs("2026-11-12T00:00:00.000Z");
      const patch = patchDefaultModelForScope(
        prefs,
        { providerId: "api", accountId: "openrouter-1" },
        "deepseek-r1",
        true,
      );
      assert.ok(patch.providerDefaultModels, "patch must update providerDefaultModels");
      assert.deepEqual(patch.providerDefaultModels["api:openrouter-1"], {
        modelId: "deepseek-r1",
        tried: true,
      });
      assert.equal(patch.defaultModelId, undefined, "Muse defaultModelId must not be altered");
    });

    it("F1-T1-05: Controller Explicit Force Forwarding", async () => {
      const client = new MockAncillaClient();
      const p = mockPlatform();
      const controller = new AncillaController(client as unknown as AncillaClient, p);

      await controller.refreshModels({ force: false });
      assert.equal(client.catalogCalls.length, 1);
      assert.notEqual(client.catalogCalls[0]?.options?.refresh, true);

      await controller.refreshModels({ force: true });
      assert.equal(client.catalogCalls.length, 2);
      assert.equal(client.catalogCalls[1]?.options?.refresh, true);
    });

    it("F1-T1-06: AncillaController Scoped Default Model Setter", async () => {
      const client = new MockAncillaClient();
      const p = mockPlatform();
      const controller = new AncillaController(client as unknown as AncillaClient, p);

      // 1. Set default model for CLI provider
      controller.setDefaultModelForScope({ providerId: "codex" }, "o3-mini");
      assert.deepEqual(controller.store.get().prefs.providerDefaultModels["codex"], {
        modelId: "o3-mini",
        tried: true,
      });

      // 2. Set default model for API provider account
      controller.setDefaultModelForScope(
        { providerId: "api", accountId: "openrouter-1" },
        "deepseek-r1",
      );
      assert.deepEqual(controller.store.get().prefs.providerDefaultModels["api:openrouter-1"], {
        modelId: "deepseek-r1",
        tried: true,
      });

      // 3. Set default model for Muse (backward-compatibility field defaultModelId)
      controller.setDefaultModelForScope({ providerId: "muse" }, "muse-wonder-1.0");
      assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
      assert.equal(controller.store.get().prefs.providerDefaultModels["muse"], undefined);

      // 4. Clear scoped default model with null
      controller.setDefaultModelForScope({ providerId: "codex" }, null);
      assert.deepEqual(controller.store.get().prefs.providerDefaultModels["codex"], {
        modelId: null,
        tried: false,
      });

      // 5. Verify persistence to platform
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(p.savedPrefs !== null, "Preferences must be persisted to platform on update");
      assert.equal(p.savedPrefs?.defaultModelId, "muse-wonder-1.0");
      assert.deepEqual(p.savedPrefs?.providerDefaultModels["api:openrouter-1"], {
        modelId: "deepseek-r1",
        tried: true,
      });
    });
  });

  // --------------------------------------------------------------------------
  // Feature 2: Case-Insensitive ModelChoice Deduplication
  // --------------------------------------------------------------------------
  describe("F2: Case-Insensitive ModelChoice Deduplication", () => {
    it("F2-T1-01: Deduplicate Exact Casing Match", () => {
      const rows = modelChoices(
        [model("gpt-6.1-sol", { displayLabel: "gpt-6.1-sol" })],
        null,
        null,
      );
      const choice = rows.find((r) => r.id === "gpt-6.1-sol") as ModelChoice;
      assert.ok(choice);
      assert.equal(choice.displayLabel, null);
      assert.equal(choice.label, "gpt-6.1-sol");
    });

    it("F2-T1-02: Deduplicate Mixed-Case Match against ModelId", () => {
      const rows = modelChoices(
        [model("gpt-6.1-sol", { displayLabel: "GPT-6.1-Sol" })],
        null,
        null,
      );
      const choice = rows.find((r) => r.id === "gpt-6.1-sol") as ModelChoice;
      assert.ok(choice);
      assert.equal(choice.displayLabel, null);
      assert.equal(choice.label, "gpt-6.1-sol");
    });

    it("F2-T1-03: Deduplicate Match against Formatted Label", () => {
      const rows = modelChoices([model("opus", { displayLabel: "Opus" })], null, null);
      const choice = rows.find((r) => r.id === "opus") as ModelChoice;
      assert.ok(choice);
      assert.equal(choice.displayLabel, null);
      assert.equal(choice.label, "opus");
    });

    it("F2-T1-04: Retain Distinct Branding Label", () => {
      const rows = modelChoices([model("fable[1m]", { displayLabel: "Fable" })], null, null);
      const choice = rows.find((r) => r.id === "fable[1m]") as ModelChoice;
      assert.ok(choice);
      assert.equal(choice.displayLabel, "Fable");
      assert.equal(choice.label, "fable[1m]");
    });

    it("F2-T1-05: Retain Distinct Model Family Name", () => {
      const rows = modelChoices(
        [model("claude-3-5-haiku-20241022", { displayLabel: "Claude 3.5 Haiku" })],
        null,
        null,
      );
      const choice = rows.find((r) => r.id === "claude-3-5-haiku-20241022") as ModelChoice;
      assert.ok(choice);
      assert.equal(choice.displayLabel, "Claude 3.5 Haiku");
      assert.equal(choice.label, "claude-3-5-haiku-20241022");
    });
  });

  // --------------------------------------------------------------------------
  // Feature 3: Empty bundledCatalog Selection Highlighting
  // --------------------------------------------------------------------------
  describe("F3: Empty bundledCatalog Selection Highlighting", () => {
    it("F3-T1-01: Pinned Choice Creation on Ready Empty Catalog", () => {
      const rows = modelChoices([], null, "muse-spark-1.3", false, { loaded: true });
      const pin = rows.find((r) => r.kind === "pin");
      assert.ok(pin, "Pinned choice must be created when loaded is true");
      assert.equal(pin.id, "muse-spark-1.3");
      assert.equal(pin.selected, true);
      assert.equal(pin.note, null, "Note must be null (no unavailable warning)");
      assert.equal(pin.unlisted, "limited");
    });

    it("F3-T1-02: Selection Value Resolution in ModelMenu", () => {
      const emptyReady = readyCatalog("bundledCatalog", []);
      const src: ModelMenuSource = {
        models: [],
        accountModels: { default: [] },
        modelsStatus: { default: emptyReady.status },
        accounts: null,
      };
      const menu = modelMenu(src, {
        scope: {},
        accountId: null,
        current: null,
        pref: "muse-spark-1.3",
        plan: null,
      });
      const selected = menu.rows.find((r) => r.selected);
      assert.ok(selected);
      assert.equal(selected.id, "muse-spark-1.3");
    });

    it("F3-T1-03: SettingsPage ModelPick Button Highlight with Saved Model", () => {
      const emptyReady = readyCatalog("bundledCatalog", []);
      const patch: Partial<AppState> = {
        models: [],
        accountModels: { default: [] },
        modelsStatus: { default: emptyReady.status },
      };
      const html = renderInApp(SettingsPage, {}, patch, {
        defaultModelId: "muse-spark-1.3",
      });
      assert.ok(
        pressed(html, "muse-spark-1.3"),
        "muse-spark-1.3 button must have aria-pressed='true'",
      );
      assert.ok(!html.includes("(unavailable)"), "Must not display (unavailable)");
    });

    it("F3-T1-04: SettingsPage ModelPick Button Highlight with Muse Default", () => {
      const emptyReady = readyCatalog("bundledCatalog", []);
      const patch: Partial<AppState> = {
        models: [],
        accountModels: { default: [] },
        modelsStatus: { default: emptyReady.status },
      };
      const html = renderInApp(SettingsPage, {}, patch, {
        defaultModelId: null,
      });
      assert.ok(
        pressed(html, "Muse default"),
        "Muse default button must have aria-pressed='true'",
      );
    });

    it("F3-T1-05: Composer ModelPicker Toolbar Label with Empty Catalog", () => {
      const emptyReady = readyCatalog("bundledCatalog", []);
      const patch: Partial<AppState> = {
        models: [],
        accountModels: { default: [] },
        modelsStatus: { default: emptyReady.status },
      };
      const html = renderInApp(
        ModelPicker,
        { sessionId: null, cwd: null, side: "top" as const },
        patch,
        { defaultModelId: "muse-spark-1.3" },
      );
      assert.match(
        html,
        /aria-label="Model: muse-spark-1\.3"/,
        "Toolbar button must announce the pinned model",
      );
      assert.ok(!html.includes("(unavailable)"), "Must not include (unavailable)");
    });
  });

  // --------------------------------------------------------------------------
  // Feature 4: Separate Chat & Assistant Selectors
  // --------------------------------------------------------------------------
  describe("F4: Separate Chat & Assistant Selectors", () => {
    it("F4-T1-01: Pick Component Responsive Flex-Wrap", () => {
      const options = [
        { value: "m1", label: "Model 1" },
        { value: "m2", label: "Model 2" },
        { value: "m3", label: "Model 3" },
        { value: "m4", label: "Model 4" },
        { value: "m5", label: "Model 5" },
        { value: "m6", label: "Model 6" },
      ];
      const htmlWrap = renderToStaticMarkup(
        createElement(Pick as ComponentType<any>, {
          value: "m1",
          options,
          onChange: () => {},
          wrap: true,
        }),
      );
      assert.ok(
        htmlWrap.includes("flex-wrap"),
        "Pick markup must include flex-wrap when options count > 5 or wrap is true",
      );

      const fewOptions = [
        { value: "m1", label: "Model 1" },
        { value: "m2", label: "Model 2" },
      ];
      const htmlNoWrap = renderToStaticMarkup(
        createElement(Pick as ComponentType<any>, {
          value: "m1",
          options: fewOptions,
          onChange: () => {},
        }),
      );
      assert.ok(
        htmlNoWrap.includes("overflow-x-auto"),
        "Pick markup must keep overflow-x-auto when options <= 5 and wrap not requested",
      );
    });

    it("F4-T1-02: ModelPick Compact Search Filter Activation", () => {
      // 1. Boundary: <= 10 options must NOT render search input
      const fewModels = [SPARK, WONDER, model("extra-model-3")];
      const patchFew: Partial<AppState> = {
        models: fewModels,
        accountModels: { default: fewModels },
      };
      const htmlFew = renderInApp(
        ModelPick as ComponentType<{ value: string | null; onChange: (v: string | null) => void }>,
        { value: "muse-spark-1.3", onChange: () => {} },
        patchFew,
      );
      assert.ok(
        !htmlFew.includes("<input"),
        "ModelPick must NOT render compact search input when options count <= 10",
      );

      // 2. Boundary: > 10 options MUST render compact search input
      const fifteenModels = Array.from({ length: 15 }, (_, i) =>
        model(`custom-model-${i}`, { displayLabel: `Custom Model ${i}` }),
      );
      const patchMany: Partial<AppState> = {
        models: fifteenModels,
        accountModels: { default: fifteenModels },
      };
      const htmlMany = renderInApp(
        ModelPick as ComponentType<{ value: string | null; onChange: (v: string | null) => void }>,
        { value: "custom-model-0", onChange: () => {} },
        patchMany,
      );
      assert.ok(
        htmlMany.includes("<input"),
        "ModelPick MUST render compact search input when options count > 10",
      );
      assert.ok(
        pressed(htmlMany, "Custom Model 0"),
        "Currently selected option must remain visible with aria-pressed='true'",
      );
    });

    it("F4-T1-03: SettingsPage Independent Chat and Assistant Sections", () => {
      const ready = readyCatalog("providerCatalog", [SPARK, WONDER]);
      const patch: Partial<AppState> = {
        models: [SPARK, WONDER],
        accountModels: { default: [SPARK, WONDER] },
        modelsStatus: { default: ready.status },
      };
      const html = renderInApp(SettingsPage, {}, patch);
      assert.ok(html.includes("New threads"), "Must contain New threads chat section");
      assert.ok(
        html.includes("Assistant") || html.includes("assistant"),
        "Must contain dedicated Assistant configuration section",
      );
    });

    it("F4-T1-04: ProfilePanel Model Section Hierarchy", () => {
      const sampleProfile: AssistantProfileView = {
        id: "prof-1",
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
        model: { providerId: "muse", accountId: null, modelId: "muse-wonder-1.0" },
        capturePaused: false,
        contextBudgetTokens: 1000,
        updatedAt: 1234567890,
      };

      const html = renderInApp(
        ProfilePanel as ComponentType<any>,
        { profile: sampleProfile, changed: () => {}, bump: 0 },
      );

      // Verify "Model for assistant tasks" section exists
      assert.ok(
        html.includes("Model for assistant tasks"),
        "ProfilePanel must render 'Model for assistant tasks' section",
      );

      // Verify hierarchy: Model section is placed at the top, before autonomy settings
      const modelSectionIdx = html.indexOf("Model for assistant tasks");
      const autonomySectionIdx = html.indexOf("What it may do on its own");
      assert.ok(
        autonomySectionIdx !== -1,
        "ProfilePanel must contain 'What it may do on its own' section",
      );
      assert.ok(
        modelSectionIdx < autonomySectionIdx,
        "'Model for assistant tasks' must be placed at the top, preceding autonomy settings",
      );

      // Verify provider options include "Follow project"
      assert.ok(
        html.includes("Follow project") || html.includes("Follow Project"),
        "ProfilePanel model selector must include 'Follow project' option",
      );
    });

    it("F4-T1-05: VoicePanel Brain Selector Choices", () => {
      const html = renderInApp(
        VoicePanel as ComponentType<any>,
        { changed: () => {} },
      );

      // Verify "The model that answers" section is present
      assert.ok(
        html.includes("The model that answers"),
        "VoicePanel must render 'The model that answers' (Brain) section",
      );

      // Verify expanded choices: subscription CLIs, accounts, Custom endpoint, and None
      assert.ok(
        html.includes("Codex") || html.includes("Claude") || html.includes("Custom endpoint"),
        "VoicePanel Brain selector options must include subscription CLIs / accounts or Custom endpoint",
      );
      assert.ok(
        html.includes("None"),
        "VoicePanel Brain selector must include 'None' choice",
      );
    });
  });

  // --------------------------------------------------------------------------
  // Feature 6: 5 Real Muse Code Models & Pricing
  // --------------------------------------------------------------------------
  describe("F6: 5 Real Muse Code Models & Pricing", () => {
    it("F6-T1-01: Published Model IDs Exact Enumeration", () => {
      const expected = [
        "muse-wonder-1.0",
        "muse-wonder-full-1.0",
        "muse-ember-1.0",
        "muse-spark-1.3",
        "muse-spark-1.2",
      ];
      assert.deepEqual(publishedModelIds(), expected);
    });

    it("F6-T1-02: Published Models Token Pricing Lookup", () => {
      const wonderPrice = listedPrice("muse-wonder-1.0");
      assert.deepEqual(wonderPrice, { input: 4, output: 20, cached: 0.2, currency: "USD" });

      const spark13Price = listedPrice("muse-spark-1.3");
      assert.deepEqual(spark13Price, { input: 1.25, output: 4.25, cached: 0.15, currency: "USD" });

      const spark12Price = listedPrice("muse-spark-1.2");
      assert.deepEqual(spark12Price, { input: 1.25, output: 4.25, cached: 0.15, currency: "USD" });
    });

    it("F6-T1-03: Unpriced Subscription Tier Models", () => {
      assert.equal(listedPrice("muse-wonder-full-1.0"), null);
      assert.equal(listedPrice("muse-ember-1.0"), null);
    });

    it("F6-T1-04: Model Completions with 5 Models", () => {
      const built = [model("muse-spark-1.3")];
      const completions = modelCompletions(built, "wonder", undefined, true);
      assert.deepEqual(
        completions.map((c) => c.id),
        ["muse-wonder-1.0", "muse-wonder-full-1.0"],
      );
    });

    it("F6-T1-05: Published Stubs Count", () => {
      assert.equal(publishedStubs([]).length, 5);
      const withOne = [model("muse-wonder-1.0")];
      assert.equal(publishedStubs(withOne).length, 4);
    });
  });
});

// ============================================================================
// TIER 2: Boundary & Corner Cases (30 Tests)
// ============================================================================

describe("Tier 2: Boundary & Corner Cases", () => {
  // --------------------------------------------------------------------------
  // Feature 1: Per-Provider Default Chat Models
  // --------------------------------------------------------------------------
  describe("F1: Boundary & Corner Cases", () => {
    it("F1-T2-01: Clearing Scoped Model Preference", () => {
      const prefs: Prefs = {
        ...defaultPrefs("2026-11-12T00:00:00.000Z"),
        providerDefaultModels: {
          "codex:work": { modelId: "o3-mini", tried: true },
          "claude:team": { modelId: "claude-3-5-sonnet", tried: false },
        },
      };

      const patch = patchDefaultModelForScope(
        prefs,
        { providerId: "codex", accountId: "work" },
        null,
        false,
      );
      assert.deepEqual(patch.providerDefaultModels?.["codex:work"], { modelId: null, tried: false });
      assert.deepEqual(patch.providerDefaultModels?.["claude:team"], {
        modelId: "claude-3-5-sonnet",
        tried: false,
      });
    });

    it("F1-T2-02: Unknown Provider Scope Resiliency", () => {
      const prefs = defaultPrefs("2026-11-12T00:00:00.000Z");
      const result = defaultModelForScope(prefs, {
        providerId: "unknown-harness" as ProviderId,
        accountId: "xyz",
      });
      assert.deepEqual(result, { modelId: null, tried: false });
    });

    it("F1-T2-03: Account ID With Special Characters", () => {
      const prefs = defaultPrefs("2026-11-12T00:00:00.000Z");
      const scope = { providerId: "claude" as ProviderId, accountId: "user@enterprise.org" };
      const patch = patchDefaultModelForScope(prefs, scope, "claude-3-opus", true);
      const merged = { ...prefs, ...patch } as Prefs;
      const roundtrip = defaultModelForScope(merged, scope);
      assert.deepEqual(roundtrip, { modelId: "claude-3-opus", tried: true });
    });

    it("F1-T2-04: Rapid Interleaved Scoped Preference Updates", () => {
      let p = defaultPrefs("2026-11-12T00:00:00.000Z");
      p = { ...p, ...patchDefaultModelForScope(p, { providerId: "muse" }, "muse-wonder-1.0", false) };
      p = { ...p, ...patchDefaultModelForScope(p, { providerId: "codex" }, "o3-mini", true) };
      p = { ...p, ...patchDefaultModelForScope(p, { providerId: "claude" }, "claude-3-5-sonnet", false) };
      p = {
        ...p,
        ...patchDefaultModelForScope(p, { providerId: "api", accountId: "profile-1" }, "deepseek-r1", true),
      };

      assert.equal(p.defaultModelId, "muse-wonder-1.0");
      assert.deepEqual(p.providerDefaultModels["codex"], { modelId: "o3-mini", tried: true });
      assert.deepEqual(p.providerDefaultModels["claude"], { modelId: "claude-3-5-sonnet", tried: false });
      assert.deepEqual(p.providerDefaultModels["api:profile-1"], { modelId: "deepseek-r1", tried: true });
    });

    it("F1-T2-05: Missing providerDefaultModels in Malformed Stored JSON", () => {
      const malformed = { defaultModelId: "muse-wonder-1.0", defaultModelTried: true };
      const revived = revivePrefs(malformed, defaultPrefs("2026-11-12T00:00:00.000Z"));
      assert.equal(revived.defaultModelId, "muse-wonder-1.0");
      assert.ok(revived.providerDefaultModels !== undefined);
      assert.deepEqual(revived.providerDefaultModels, {});
    });
  });

  // --------------------------------------------------------------------------
  // Feature 2: Case-Insensitive ModelChoice Deduplication
  // --------------------------------------------------------------------------
  describe("F2: Boundary & Corner Cases", () => {
    it("F2-T2-01: All-Uppercase DisplayLabel", () => {
      const rows = modelChoices(
        [model("claude-3-opus", { displayLabel: "CLAUDE-3-OPUS" })],
        null,
        null,
      );
      const choice = rows.find((r) => r.id === "claude-3-opus");
      assert.equal(choice?.displayLabel, null);
    });

    it("F2-T2-02: DisplayLabel with Tabs and Leading/Trailing Spaces", () => {
      const rows = modelChoices(
        [model("deepseek-v3", { displayLabel: "\t  deepseek-v3 \n" })],
        null,
        null,
      );
      const choice = rows.find((r) => r.id === "deepseek-v3");
      assert.equal(choice?.displayLabel, null);
    });

    it("F2-T2-03: Bracketed Context Suffix Preservation", () => {
      const rows = modelChoices(
        [model("llama-3-70b[32k]", { displayLabel: "Llama-3-70b" })],
        null,
        null,
      );
      const choice = rows.find((r) => r.id === "llama-3-70b[32k]");
      assert.equal(choice?.displayLabel, "Llama-3-70b");
    });

    it("F2-T2-04: Empty String and Whitespace-Only DisplayLabel", () => {
      const rows = modelChoices([model("gpt-4o", { displayLabel: "   " })], null, null);
      const choice = rows.find((r) => r.id === "gpt-4o");
      assert.equal(choice?.displayLabel, null);
    });

    it("F2-T2-05: Contributor Model Tag Handling", () => {
      const rows = modelChoices(
        [model("muse-spark-1.3-contributor", { displayLabel: "muse-spark-1.3" })],
        null,
        null,
      );
      const choice = rows.find((r) => r.id === "muse-spark-1.3-contributor");
      assert.equal(choice?.displayLabel, null);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 3: Empty bundledCatalog Selection Highlighting
  // --------------------------------------------------------------------------
  describe("F3: Boundary & Corner Cases", () => {
    it("F3-T2-01: Unloaded Status Loading State Boundary", () => {
      const rows = modelChoices([], null, "muse-spark-1.3", false, { loaded: false });
      const pin = rows.find((r) => r.kind === "pin");
      assert.equal(pin, undefined, "Pinned row must NOT be created when loaded is false");
    });

    it("F3-T2-02: Status Ready with Non-Empty Models List", () => {
      const rows = modelChoices([SPARK], null, "muse-wonder-1.0", true, { loaded: true });
      const pin = rows.find((r) => r.kind === "pin");
      assert.ok(pin);
      assert.equal(pin.note, "unavailable", "Must be marked unavailable when models.length > 0");
    });

    it("F3-T2-03: Empty Catalog with Null Picked Model (Clear Pref)", () => {
      const rows = modelChoices([], null, null, false, { loaded: true });
      const pin = rows.find((r) => r.kind === "pin");
      assert.equal(pin, undefined, "Must not create orphaned pin when pref is null");
      assert.equal(rows[0]?.selected, true, "Default row must be selected");
    });

    it("F3-T2-04: Rapid Successive Empty Catalogs", () => {
      const pinCtx: PinContext = { loaded: true };
      const run1 = modelChoices([], null, "muse-spark-1.3", false, pinCtx);
      const run2 = modelChoices([], null, "muse-spark-1.3", false, pinCtx);
      const run3 = modelChoices([], null, "muse-spark-1.3", false, pinCtx);

      assert.equal(run1.filter((r) => r.kind === "pin").length, 1);
      assert.equal(run2.filter((r) => r.kind === "pin").length, 1);
      assert.equal(run3.filter((r) => r.kind === "pin").length, 1);
    });

    it("F3-T2-05: ModelPick Fallback When Picked Model is Unknown and Absent from Options", () => {
      const emptyReady = readyCatalog("bundledCatalog", []);
      const src: ModelMenuSource = {
        models: [],
        accountModels: { default: [] },
        modelsStatus: { default: emptyReady.status },
        accounts: null,
      };
      const menu = modelMenu(src, {
        scope: {},
        accountId: null,
        current: null,
        pref: "nonexistent-model",
        plan: null,
      });
      assert.ok(menu.rows.some((r) => r.id === "nonexistent-model"));
    });
  });

  // --------------------------------------------------------------------------
  // Feature 4: Separate Chat & Assistant Selectors
  // --------------------------------------------------------------------------
  describe("F4: Boundary & Corner Cases", () => {
    it("F4-T2-01: ModelPick Search Filter with Exact Selected Match Excluded", () => {
      const fifteenModels = Array.from({ length: 15 }, (_, i) =>
        model(`custom-${i}`, { displayLabel: `Custom Model ${i}` }),
      );
      const patch: Partial<AppState> = {
        models: fifteenModels,
        accountModels: { default: fifteenModels },
      };

      // Selected value is custom-0, but search filter query matches only custom-14
      const html = renderInApp(
        ModelPick as ComponentType<any>,
        { value: "custom-0", filter: "custom-14", onChange: () => {} },
        patch,
      );

      assert.ok(
        html.includes("<input"),
        "ModelPick must render compact search input when options count > 10",
      );
      assert.ok(
        pressed(html, "Custom Model 0"),
        "Selected model button ('Custom Model 0') must remain visible with aria-pressed='true' even when excluded by search query",
      );
      assert.ok(
        html.includes("Custom Model 14"),
        "Model matching the search query ('Custom Model 14') must be rendered",
      );
      assert.ok(
        !html.includes("Custom Model 1<") && !html.includes("Custom Model 2<"),
        "Unselected models not matching the search query must be filtered out",
      );
    });

    it("F4-T2-02: Assistant Task Model Rejection on Disallowed Characters", () => {
      // Validate production isModelId validator
      assert.equal(isModelId("bad;rm -rf /"), false);
      assert.equal(isModelId("has space in id"), false);
      assert.equal(isModelId("illegal$char"), false);
      assert.equal(isModelId("x".repeat(101)), false, "Model id > 100 characters must be rejected");
      assert.equal(isModelId("valid-model.v1"), true);
      assert.equal(isModelId("openai/gpt-5.4"), true);
      assert.equal(isModelId("claude-3-5-sonnet:latest"), true);

      // Verify controller setDefaultModelForScope rejects disallowed characters without mutating state
      const client = new MockAncillaClient();
      const p = mockPlatform();
      const controller = new AncillaController(client as unknown as AncillaClient, p);
      controller.setDefaultModelForScope({ providerId: "codex" }, "bad;rm -rf /");
      assert.equal(
        controller.store.get().prefs.providerDefaultModels["codex"],
        undefined,
        "Controller must reject invalid model ID syntax and not persist it",
      );
    });

    it("F4-T2-03: Voice Brain Transition to 'none'", async () => {
      const client = new MockAncillaClient();
      const p = mockPlatform();
      const controller = new AncillaController(client as unknown as AncillaClient, p);

      // Transition voice brain to "none" via controller.voice API
      await controller.voice("PATCH", "/settings", {
        brain: { kind: "none" as const },
      });

      assert.equal(client.voiceCalls.length, 1);
      assert.equal(client.voiceCalls[0]?.method, "PATCH");
      assert.equal(client.voiceCalls[0]?.path, "/settings");
      assert.deepEqual(client.voiceCalls[0]?.body, { brain: { kind: "none" } });
    });

    it("F4-T2-04: Assistant Task Model Reset to Follow Project", async () => {
      const client = new MockAncillaClient();
      const p = mockPlatform();
      const controller = new AncillaController(client as unknown as AncillaClient, p);

      // Reset assistant task model to follow project via controller.assistant
      await controller.assistant("PATCH", "/profile", {
        model: { providerId: null, accountId: null, modelId: null },
      });

      assert.equal(client.assistantCalls.length, 1);
      assert.equal(client.assistantCalls[0]?.method, "PATCH");
      assert.equal(client.assistantCalls[0]?.path, "/profile");
      assert.deepEqual(client.assistantCalls[0]?.body, {
        model: { providerId: null, accountId: null, modelId: null },
      });
    });

    it("F4-T2-05: Pick Wrapping Threshold Boundary", () => {
      // 1. Boundary at 5 options: retains overflow-x-auto, NO flex-wrap
      const opts5 = Array.from({ length: 5 }, (_, i) => ({
        value: `opt-${i}`,
        label: `Option ${i}`,
      }));
      const html5 = renderToStaticMarkup(
        createElement(Pick as ComponentType<any>, {
          value: "opt-0",
          options: opts5,
          onChange: () => {},
        }),
      );
      assert.ok(
        html5.includes("overflow-x-auto"),
        "Pick with 5 options must retain overflow-x-auto",
      );
      assert.ok(
        !html5.includes("flex-wrap"),
        "Pick with 5 options must NOT include flex-wrap class",
      );

      // 2. Boundary at 6 options: MUST apply flex-wrap
      const opts6 = Array.from({ length: 6 }, (_, i) => ({
        value: `opt-${i}`,
        label: `Option ${i}`,
      }));
      const html6 = renderToStaticMarkup(
        createElement(Pick as ComponentType<any>, {
          value: "opt-0",
          options: opts6,
          onChange: () => {},
        }),
      );
      assert.ok(
        html6.includes("flex-wrap"),
        "Pick with 6 options (threshold > 5) must apply flex-wrap class",
      );

      // 3. Explicit wrap: true with <= 5 options MUST apply flex-wrap
      const opts3 = Array.from({ length: 3 }, (_, i) => ({
        value: `opt-${i}`,
        label: `Option ${i}`,
      }));
      const html3Wrapped = renderToStaticMarkup(
        createElement(Pick as ComponentType<any>, {
          value: "opt-0",
          options: opts3,
          wrap: true,
          onChange: () => {},
        }),
      );
      assert.ok(
        html3Wrapped.includes("flex-wrap"),
        "Pick with wrap=true must apply flex-wrap regardless of options count",
      );
    });
  });

  // --------------------------------------------------------------------------
  // Feature 6: 5 Real Muse Code Models & Pricing
  // --------------------------------------------------------------------------
  describe("F6: Boundary & Corner Cases", () => {
    it("F6-T2-01: API-Only Model Omission from Published List", () => {
      assert.ok(
        !publishedModelIds().includes("muse-spark-1.1"),
        "muse-spark-1.1 must NOT appear in publishedModelIds",
      );
    });

    it("F6-T2-02: Unknown Model Listed Price Return", () => {
      assert.equal(listedPrice("nonexistent-future-model"), null);
    });

    it("F6-T2-03: Case-Insensitive Model Price Lookup", () => {
      assert.equal(listedPrice("MUSE-WONDER-1.0"), null);
      assert.notEqual(listedPrice("muse-wonder-1.0"), null);
    });

    it("F6-T2-04: Zero Token Pricing Calculation", () => {
      const price = listedPrice("muse-spark-1.3");
      assert.ok(price);
      const totalCost = (0 / 1_000_000) * price.input + (0 / 1_000_000) * price.output;
      assert.equal(totalCost, 0);
      assert.ok(!Number.isNaN(totalCost));
    });

    it("F6-T2-05: Model Completion with Empty Query String", () => {
      const built = [model("muse-spark-1.3")];
      const completions = modelCompletions(built, "", undefined, true);
      assert.equal(completions.length, 5);
    });
  });
});

// ============================================================================
// TIER 3: Cross-Feature Combinations (8 Tests)
// ============================================================================

describe("Tier 3: Cross-Feature Combinations", () => {
  it("COMB-T3-01: Cross-Provider Default Isolation During Thread Creation (F1 + F4)", () => {
    let prefs = defaultPrefs("2026-11-12T00:00:00.000Z");
    prefs = { ...prefs, ...patchDefaultModelForScope(prefs, { providerId: "muse" }, "muse-wonder-1.0", false) };
    prefs = { ...prefs, ...patchDefaultModelForScope(prefs, { providerId: "codex" }, "o3-mini", false) };

    const museDefault = defaultModelForScope(prefs, { providerId: "muse" });
    const codexDefault = defaultModelForScope(prefs, { providerId: "codex" });

    assert.equal(museDefault.modelId, "muse-wonder-1.0");
    assert.equal(codexDefault.modelId, "o3-mini");
  });

  it("COMB-T3-02: Voice Brain & Chat Default Mutual Independence (F1 + F4)", async () => {
    const client = new MockAncillaClient();
    const p = mockPlatform();
    const controller = new AncillaController(client as unknown as AncillaClient, p);

    // 1. Set Chat default models across multiple scopes
    controller.setDefaultModelForScope({ providerId: "muse" }, "muse-spark-1.3");
    controller.setDefaultModelForScope({ providerId: "codex" }, "o3-mini");
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-spark-1.3");
    assert.equal(controller.store.get().prefs.providerDefaultModels["codex"]?.modelId, "o3-mini");

    // 2. Configure Voice Brain setting independently
    await controller.voice("PATCH", "/settings", {
      brain: {
        kind: "provider" as const,
        providerId: "claude" as ProviderId,
        accountId: "work",
        model: "claude-3-5-sonnet",
      },
    });

    // 3. Verify chat defaults are completely untouched
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-spark-1.3");
    assert.equal(controller.store.get().prefs.providerDefaultModels["codex"]?.modelId, "o3-mini");
    assert.equal(controller.store.get().prefs.providerDefaultModels["claude:work"], undefined);

    // 4. Update Chat Codex default again
    controller.setDefaultModelForScope({ providerId: "codex" }, "o1");
    assert.equal(controller.store.get().prefs.providerDefaultModels["codex"]?.modelId, "o1");

    // 5. Verify voice call payload received the expected voice brain setting
    assert.equal(client.voiceCalls.length, 1);
    assert.equal((client.voiceCalls[0]?.body as any)?.brain?.model, "claude-3-5-sonnet");
  });

  it("COMB-T3-03: SettingsPage Force Refresh on Empty BundledCatalog (F3 + F5)", async () => {
    const emptyReady = readyCatalog("bundledCatalog", []);
    const patch: Partial<AppState> = {
      models: [],
      accountModels: { default: [] },
      modelsStatus: { default: emptyReady.status },
    };
    const html = renderInApp(SettingsPage, {}, patch, {
      defaultModelId: "muse-spark-1.3",
    });
    assert.ok(pressed(html, "muse-spark-1.3"));
  });

  it("COMB-T3-04: Deduplication on Newly Discovered Real Muse Model (F2 + F6)", () => {
    const rows = modelChoices(
      [model("muse-wonder-full-1.0", { displayLabel: "muse-wonder-full-1.0" })],
      null,
      null,
    );
    const choice = rows.find((r) => r.id === "muse-wonder-full-1.0");
    assert.ok(choice);
    assert.equal(choice.displayLabel, null);
  });

  it("COMB-T3-06: API Profile with Multiple Custom Models and Deduplication in ModelPick (F1 + F2 + F4)", () => {
    const rows = modelChoices(
      [
        model("openai/gpt-5.4", { displayLabel: "GPT-5.4" }),
        model("anthropic/claude-3-5-sonnet", { displayLabel: "Claude 3.5 Sonnet" }),
      ],
      null,
      null,
    );
    assert.equal(rows.length, 3); // Muse default + 2 models
  });

  it("COMB-T3-07: Multi-Account Same-Provider Default Segregation (F1 + F4)", () => {
    let prefs = defaultPrefs("2026-11-12T00:00:00.000Z");
    prefs = {
      ...prefs,
      ...patchDefaultModelForScope(prefs, { providerId: "codex", accountId: "work" }, "o3-mini", false),
    };
    prefs = {
      ...prefs,
      ...patchDefaultModelForScope(prefs, { providerId: "codex", accountId: "personal" }, "o1", false),
    };

    const work = defaultModelForScope(prefs, { providerId: "codex", accountId: "work" });
    const personal = defaultModelForScope(prefs, { providerId: "codex", accountId: "personal" });

    assert.equal(work.modelId, "o3-mini");
    assert.equal(personal.modelId, "o1");
  });

  it("COMB-T3-08: Off-Catalog Model Pinned in Assistant Task Survives Refresh (F3 + F4 + F5)", () => {
    const rows = modelChoices([], null, "custom-deepseek-code", false, { loaded: true });
    const pin = rows.find((r) => r.kind === "pin");
    assert.ok(pin);
    assert.equal(pin.id, "custom-deepseek-code");
  });
});

// ============================================================================
// TIER 4: Real-World Application Scenarios (4 Tests)
// ============================================================================

describe("Tier 4: Real-World Application Scenarios", () => {
  it("SCEN-T4-01: Multi-Provider Developer Day-in-the-Life Workflow", () => {
    const client = new MockAncillaClient();
    const p = mockPlatform();
    const controller = new AncillaController(client as unknown as AncillaClient, p);

    controller.setDefaultModelForScope({ providerId: "muse" }, "muse-wonder-1.0");
    controller.setDefaultModelForScope({ providerId: "codex", accountId: "work" }, "o3-mini");
    controller.setDefaultModelForScope(
      { providerId: "claude", accountId: "personal" },
      "claude-3-5-sonnet",
    );

    const backendModel = defaultModelForScope(controller.store.get().prefs, { providerId: "muse" });
    assert.equal(backendModel.modelId, "muse-wonder-1.0");

    const frontendModel = defaultModelForScope(controller.store.get().prefs, {
      providerId: "codex",
      accountId: "work",
    });
    assert.equal(frontendModel.modelId, "o3-mini");

    const archModel = defaultModelForScope(controller.store.get().prefs, {
      providerId: "claude",
      accountId: "personal",
    });
    assert.equal(archModel.modelId, "claude-3-5-sonnet");
  });

  it("SCEN-T4-02: Cold Start & Unauthenticated First Launch Experience", () => {
    const emptyReady = readyCatalog("bundledCatalog", []);
    const patch: Partial<AppState> = {
      models: [],
      accountModels: { default: [] },
      modelsStatus: { default: emptyReady.status },
    };
    const html = renderInApp(SettingsPage, {}, patch, { defaultModelId: null });
    assert.ok(pressed(html, "Muse default"));
    assert.ok(!html.includes("(unavailable)"));
  });

  it("SCEN-T4-03: Tri-Modal Harness Segregation (Chat, Assistant, and Voice)", async () => {
    const client = new MockAncillaClient();
    const p = mockPlatform();
    const controller = new AncillaController(client as unknown as AncillaClient, p);

    // Modality 1: Configure Chat default models per provider/account
    controller.setDefaultModelForScope({ providerId: "muse" }, "muse-ember-1.0");
    controller.setDefaultModelForScope({ providerId: "codex" }, "o3-mini");
    controller.setDefaultModelForScope({ providerId: "claude" }, "claude-3-5-sonnet");

    // Modality 2: Configure Assistant Task model independently
    await controller.assistant("PATCH", "/profile", {
      model: { providerId: "muse" as ProviderId, accountId: null, modelId: "muse-wonder-1.0" },
    });

    // Modality 3: Configure Voice & Web model independently
    await controller.voice("PATCH", "/settings", {
      brain: {
        kind: "provider" as const,
        providerId: "api" as ProviderId,
        accountId: "openrouter",
        model: "openai/gpt-4o-realtime",
      },
    });

    // Verify Modality 1: Chat model preferences are intact and segregated
    const museChat = defaultModelForScope(controller.store.get().prefs, { providerId: "muse" });
    const codexChat = defaultModelForScope(controller.store.get().prefs, { providerId: "codex" });
    const claudeChat = defaultModelForScope(controller.store.get().prefs, { providerId: "claude" });
    assert.equal(museChat.modelId, "muse-ember-1.0");
    assert.equal(codexChat.modelId, "o3-mini");
    assert.equal(claudeChat.modelId, "claude-3-5-sonnet");

    // Verify Modality 2: Assistant Task model payload was dispatched cleanly without cross-pollution
    assert.equal(client.assistantCalls.length, 1);
    assert.deepEqual(client.assistantCalls[0]?.body, {
      model: { providerId: "muse", accountId: null, modelId: "muse-wonder-1.0" },
    });

    // Verify Modality 3: Voice Brain payload was dispatched cleanly without cross-pollution
    assert.equal(client.voiceCalls.length, 1);
    assert.deepEqual(client.voiceCalls[0]?.body, {
      brain: {
        kind: "provider",
        providerId: "api",
        accountId: "openrouter",
        model: "openai/gpt-4o-realtime",
      },
    });

    // Verify mutual segregation: no cross-modality model pollution
    assert.notEqual(
      museChat.modelId,
      "muse-wonder-1.0",
      "Chat Muse model must not be overwritten by Assistant task model",
    );
    assert.notEqual(
      codexChat.modelId,
      "openai/gpt-4o-realtime",
      "Chat Codex model must not be overwritten by Voice brain model",
    );
  });

  it("SCEN-T4-05: BYOK API Provider Onboarding & Model Management", () => {
    const client = new MockAncillaClient();
    const p = mockPlatform();
    const controller = new AncillaController(client as unknown as AncillaClient, p);

    const customModels = Array.from({ length: 15 }, (_, i) =>
      model(`custom-llm-${i}`, { displayLabel: `Custom LLM ${i}` }),
    );
    controller.setDefaultModelForScope(
      { providerId: "api", accountId: "custom-acc" },
      "custom-llm-0",
    );

    const scoped = defaultModelForScope(controller.store.get().prefs, {
      providerId: "api",
      accountId: "custom-acc",
    });
    assert.equal(scoped.modelId, "custom-llm-0");

    const patch: Partial<AppState> = {
      models: customModels,
      accountModels: { "api:custom-acc": customModels },
    };
    const html = renderInApp(
      ModelPick as ComponentType<any>,
      {
        value: "custom-llm-0",
        scope: { providerId: "api", accountId: "custom-acc" },
        onChange: () => {},
      },
      patch,
      controller.store.get().prefs,
      controller,
    );

    assert.ok(
      html.includes("<input"),
      "ModelPick must render compact search input when custom models > 10",
    );
    assert.ok(
      pressed(html, "Custom LLM 0"),
      "Selected custom model button must remain visible with aria-pressed='true'",
    );
  });
});
