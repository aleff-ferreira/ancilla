import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { ModelPick, Pick } from "../src/components/settings/SettingsPage.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import {
  knownModels,
  modelStub,
  modelsKey,
  type ModelMenuOptions,
  type ModelMenuSource,
} from "../src/model/models.js";
import { defaultPrefs, initialState, Store, type AppState, type Prefs } from "../src/model/store.js";
import type { ModelCatalogInfo, ModelOption, ModelsStatus } from "../src/types.js";

const model = (modelId: string, extra: Partial<ModelOption> = {}): ModelOption => modelStub(modelId, extra);

function catalog(source: string | null): ModelCatalogInfo {
  return { source, providerId: "meta", profileId: "tbh", hostVersion: "1.4.7" };
}

function ready(info: ModelCatalogInfo | null): ModelsStatus {
  return { status: "ready", error: null, loadedAt: 1_000, catalog: info };
}

function listed(lists: Record<string, ModelOption[]>, sources: Record<string, string>) {
  const modelsStatus = Object.fromEntries(
    Object.entries(sources).map(([key, source]) => [key, ready(catalog(source))]),
  );
  return { models: knownModels(lists, modelsStatus), accountModels: lists, modelsStatus };
}

function render<P extends object>(
  Component: ComponentType<P>,
  props: P,
  patch: Partial<AppState> = {},
  prefs: Partial<Prefs> = {},
): string {
  const store = new Store<AppState>({
    ...initialState({ ...defaultPrefs("2026-11-12T00:00:00.000Z"), ...prefs }),
    connection: "open",
    ...patch,
  });
  const controller = {
    store,
    loadAccounts: async () => {},
    refreshModels: async () => {},
    setDefaultModelForScope: () => {},
  } as unknown as AncillaController;

  return renderToStaticMarkup(
    createElement(ControllerProvider, {
      controller,
      children: createElement(TooltipProvider, {
        children: createElement(Component, props),
      }),
    }),
  );
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function directlyPressed(html: string, label: string): boolean {
  const re = new RegExp(`aria-pressed="true"[^>]*>${escapeRegex(label)}<`);
  return re.test(html);
}

// ============================================================================
// 1. Pick Wrapping Boundaries & Direct Button Markup
// ============================================================================

describe("Pick component empirical stress test - wrapping boundaries & direct markup", () => {
  it("0 options: has overflow-x-auto and NOT flex-wrap", () => {
    const html = renderToStaticMarkup(
      createElement(Pick, {
        value: null,
        options: [],
        onChange: () => {},
      }),
    );
    assert.ok(html.includes("overflow-x-auto"), "0 options must have overflow-x-auto");
    assert.ok(!html.includes("flex-wrap"), "0 options must NOT have flex-wrap");
  });

  it("1 option: has overflow-x-auto, NOT flex-wrap, and direct button text child", () => {
    const label = "Single Option";
    const html = renderToStaticMarkup(
      createElement(Pick, {
        value: "opt-1",
        options: [{ value: "opt-1", label }],
        onChange: () => {},
      }),
    );
    assert.ok(html.includes("overflow-x-auto"), "1 option must have overflow-x-auto");
    assert.ok(!html.includes("flex-wrap"), "1 option must NOT have flex-wrap");
    assert.ok(
      directlyPressed(html, label),
      "Regex /aria-pressed=\"true\"[^>]*>${label}</ must match directly without intermediate span tags",
    );
  });

  it("5 options (upper boundary <= 5): has overflow-x-auto and NOT flex-wrap", () => {
    const options = Array.from({ length: 5 }, (_, i) => ({
      value: `opt-${i + 1}`,
      label: `Option ${i + 1}`,
    }));
    const html = renderToStaticMarkup(
      createElement(Pick, {
        value: "opt-3",
        options,
        onChange: () => {},
      }),
    );
    assert.ok(html.includes("overflow-x-auto"), "5 options must have overflow-x-auto");
    assert.ok(!html.includes("flex-wrap"), "5 options must NOT have flex-wrap");
    assert.ok(
      directlyPressed(html, "Option 3"),
      "Selected option must match directly without intermediate span tags",
    );
  });

  it("6 options (lower boundary > 5): has flex-wrap and NOT overflow-x-auto", () => {
    const options = Array.from({ length: 6 }, (_, i) => ({
      value: `opt-${i + 1}`,
      label: `Option ${i + 1}`,
    }));
    const html = renderToStaticMarkup(
      createElement(Pick, {
        value: "opt-6",
        options,
        onChange: () => {},
      }),
    );
    assert.ok(html.includes("flex-wrap"), "6 options must have flex-wrap");
    assert.ok(!html.includes("overflow-x-auto"), "6 options must NOT have overflow-x-auto");
    assert.ok(
      directlyPressed(html, "Option 6"),
      "Selected option must match directly without intermediate span tags",
    );
  });

  it("10 options: has flex-wrap and NOT overflow-x-auto", () => {
    const options = Array.from({ length: 10 }, (_, i) => ({
      value: `opt-${i + 1}`,
      label: `Option ${i + 1}`,
    }));
    const html = renderToStaticMarkup(
      createElement(Pick, {
        value: "opt-10",
        options,
        onChange: () => {},
      }),
    );
    assert.ok(html.includes("flex-wrap"), "10 options must have flex-wrap");
    assert.ok(!html.includes("overflow-x-auto"), "10 options must NOT have overflow-x-auto");
    assert.ok(
      directlyPressed(html, "Option 10"),
      "Selected option must match directly without intermediate span tags",
    );
  });

  it("50 options (stress load): has flex-wrap and NOT overflow-x-auto", () => {
    const options = Array.from({ length: 50 }, (_, i) => ({
      value: `opt-${i + 1}`,
      label: `Option ${i + 1} (Detail [Test])`,
    }));
    const html = renderToStaticMarkup(
      createElement(Pick, {
        value: "opt-42",
        options,
        onChange: () => {},
      }),
    );
    assert.ok(html.includes("flex-wrap"), "50 options must have flex-wrap");
    assert.ok(!html.includes("overflow-x-auto"), "50 options must NOT have overflow-x-auto");
    assert.ok(
      directlyPressed(html, "Option 42 (Detail [Test])"),
      "Selected option 42 with special chars must match directly",
    );
  });

  it("wrap: true with 1 option: has flex-wrap and NOT overflow-x-auto", () => {
    const label = "Wrap 1";
    const html = renderToStaticMarkup(
      createElement(Pick, {
        value: "opt-1",
        options: [{ value: "opt-1", label }],
        wrap: true,
        onChange: () => {},
      }),
    );
    assert.ok(html.includes("flex-wrap"), "wrap: true with 1 option must have flex-wrap");
    assert.ok(!html.includes("overflow-x-auto"), "wrap: true with 1 option must NOT have overflow-x-auto");
    assert.ok(directlyPressed(html, label));
  });

  it("wrap: true with 2 options: has flex-wrap and NOT overflow-x-auto", () => {
    const label = "Wrap 2";
    const html = renderToStaticMarkup(
      createElement(Pick, {
        value: "opt-2",
        options: [
          { value: "opt-1", label: "Wrap 1" },
          { value: "opt-2", label },
        ],
        wrap: true,
        onChange: () => {},
      }),
    );
    assert.ok(html.includes("flex-wrap"), "wrap: true with 2 options must have flex-wrap");
    assert.ok(!html.includes("overflow-x-auto"), "wrap: true with 2 options must NOT have overflow-x-auto");
    assert.ok(directlyPressed(html, label));
  });

  it("strictly enforces direct text child without wrapping span tags across complex labels", () => {
    const complexLabels = [
      "Muse Spark (1.3)",
      "OpenAI GPT-4.5 [preview]",
      "Claude 3.7 Sonnet & Reasoning",
      "Model with $pecial <chars> & 'quotes'",
    ];
    const options = complexLabels.map((lbl, idx) => ({
      value: `val-${idx}`,
      label: lbl,
    }));
    for (const opt of options) {
      const html = renderToStaticMarkup(
        createElement(Pick, {
          value: opt.value,
          options,
          onChange: () => {},
        }),
      );
      const escapedLabel = opt.label
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/'/g, "&#x27;");
      const directRegex = new RegExp(`aria-pressed="true"[^>]*>${escapeRegex(escapedLabel)}<`);
      assert.ok(
        directRegex.test(html),
        `Label '${opt.label}' must be a direct child of button with aria-pressed="true"`,
      );
      assert.ok(
        !/<button[^>]*aria-pressed="true"[^>]*><span/i.test(html),
        "Button must not contain a wrapping span tag",
      );
    }
  });
});

// ============================================================================
// 2. ModelPick Filter & Activation Boundaries
// ============================================================================

describe("ModelPick empirical stress test - search filter activation & query matching", () => {
  it("options.length <= 10: does NOT render <input (at options.length 2, 6, 10)", () => {
    // In ModelPick, options = [Default row, ...model rows].
    // 1 model in provider scope yields 2 options (Default row + 1 model): options.length = 2 <= 10
    const m1 = [model("m-1", { displayLabel: "Model 1" })];
    const state1 = listed({ [modelsKey({ providerId: "codex" })]: m1 }, { [modelsKey({ providerId: "codex" })]: "providerCatalog" });
    const html1 = render(ModelPick, { value: "m-1", scope: { providerId: "codex" }, onChange: () => {} }, state1);
    assert.ok(!html1.includes("<input"), "2 options (1 model + default) must NOT render <input");

    // 5 models in provider scope yields 6 options (Default row + 5 models): options.length = 6 <= 10
    const m5 = Array.from({ length: 5 }, (_, i) => model(`m-${i + 1}`, { displayLabel: `Model ${i + 1}` }));
    const state5 = listed({ [modelsKey({ providerId: "codex" })]: m5 }, { [modelsKey({ providerId: "codex" })]: "providerCatalog" });
    const html5 = render(ModelPick, { value: "m-1", scope: { providerId: "codex" }, onChange: () => {} }, state5);
    assert.ok(!html5.includes("<input"), "6 options (5 models + default) must NOT render <input");

    // Exactly 9 models in provider scope yields exactly 10 options (Default row + 9 models): options.length = 10 <= 10
    const m9 = Array.from({ length: 9 }, (_, i) => model(`m-${i + 1}`, { displayLabel: `Model ${i + 1}` }));
    const state9 = listed({ [modelsKey({ providerId: "codex" })]: m9 }, { [modelsKey({ providerId: "codex" })]: "providerCatalog" });
    const html9 = render(ModelPick, { value: "m-1", scope: { providerId: "codex" }, onChange: () => {} }, state9);
    assert.ok(!html9.includes("<input"), "Exactly 10 options (9 models + default) must NOT render <input");
  });

  it("options.length > 10: MUST render <input (at options.length 11, 21)", () => {
    // 10 models in provider scope yields 11 options (Default row + 10 models): options.length = 11 > 10
    const m10 = Array.from({ length: 10 }, (_, i) => model(`m-${i + 1}`, { displayLabel: `Model ${i + 1}` }));
    const state10 = listed({ [modelsKey({ providerId: "codex" })]: m10 }, { [modelsKey({ providerId: "codex" })]: "providerCatalog" });
    const html10 = render(ModelPick, { value: "m-1", scope: { providerId: "codex" }, onChange: () => {} }, state10);
    assert.ok(html10.includes("<input"), "11 options (10 models + default) MUST render <input");
    assert.ok(html10.includes('type="search"'), "input must have type='search'");
    assert.ok(html10.includes('placeholder="Filter models…"'), "input must have placeholder");

    // 20 models in provider scope yields 21 options: options.length = 21 > 10
    const m20 = Array.from({ length: 20 }, (_, i) => model(`m-${i + 1}`, { displayLabel: `Model ${i + 1}` }));
    const state20 = listed({ [modelsKey({ providerId: "codex" })]: m20 }, { [modelsKey({ providerId: "codex" })]: "providerCatalog" });
    const html20 = render(ModelPick, { value: "m-5", scope: { providerId: "codex" }, onChange: () => {} }, state20);
    assert.ok(html20.includes("<input"), "21 options MUST render <input");
  });

  it("case-insensitive query matching on label", () => {
    const models = Array.from({ length: 12 }, (_, i) =>
      model(`id-${i + 1}`, { displayLabel: i === 0 ? "Gemini Pro 1.5" : `Other Model ${i + 1}` }),
    );
    const state = listed({ [modelsKey({ providerId: "gemini" })]: models }, { [modelsKey({ providerId: "gemini" })]: "providerCatalog" });

    // lowercase match
    const htmlLower = render(
      ModelPick,
      { value: "id-1", scope: { providerId: "gemini" }, filter: "gemini", onChange: () => {} },
      state,
    );
    assert.ok(htmlLower.includes("Gemini Pro 1.5"), "lowercase query must match 'Gemini Pro 1.5'");
    assert.ok(!htmlLower.includes("Other Model 2"), "unmatched models must be filtered out");

    // uppercase match
    const htmlUpper = render(
      ModelPick,
      { value: "id-1", scope: { providerId: "gemini" }, filter: "GEMINI", onChange: () => {} },
      state,
    );
    assert.ok(htmlUpper.includes("Gemini Pro 1.5"), "uppercase query must match 'Gemini Pro 1.5'");

    // mixed case substring match
    const htmlMixed = render(
      ModelPick,
      { value: "id-1", scope: { providerId: "gemini" }, filter: "pRo 1.5", onChange: () => {} },
      state,
    );
    assert.ok(htmlMixed.includes("Gemini Pro 1.5"), "mixed case query must match 'Gemini Pro 1.5'");
  });

  it("case-insensitive query matching on value (when value differs from label)", () => {
    const models = [
      model("anthropic/claude-3-7-sonnet-thought", { displayLabel: "Sonnet Thinking" }),
      ...Array.from({ length: 11 }, (_, i) => model(`other-${i + 1}`, { displayLabel: `Worker ${i + 1}` })),
    ];
    const state = listed({ [modelsKey({ providerId: "claude" })]: models }, { [modelsKey({ providerId: "claude" })]: "providerCatalog" });

    // query matches value "claude-3-7" (not in label "Sonnet Thinking")
    const htmlVal = render(
      ModelPick,
      { value: "other-1", scope: { providerId: "claude" }, filter: "claude-3-7", onChange: () => {} },
      state,
    );
    assert.ok(htmlVal.includes("Sonnet Thinking"), "Query matching value must render the option");

    // uppercase query on value
    const htmlValUpper = render(
      ModelPick,
      { value: "other-1", scope: { providerId: "claude" }, filter: "THOUGHT", onChange: () => {} },
      state,
    );
    assert.ok(htmlValUpper.includes("Sonnet Thinking"), "Uppercase query matching value must render the option");
  });

  it("handles adversarial and regex special characters in filter without crashing", () => {
    const models = [
      model("m-(special)", { displayLabel: "Model (special) [v1] + fast" }),
      ...Array.from({ length: 11 }, (_, i) => model(`other-${i + 1}`, { displayLabel: `Other ${i + 1}` })),
    ];
    const state = listed({ [modelsKey({ providerId: "codex" })]: models }, { [modelsKey({ providerId: "codex" })]: "providerCatalog" });

    const adversarialQueries = ["(special)", "[v1]", "+", "*", "?", "^", "$", "\\", "   [v1]   "];
    for (const q of adversarialQueries) {
      assert.doesNotThrow(() => {
        const html = render(
          ModelPick,
          { value: "other-1", scope: { providerId: "codex" }, filter: q, onChange: () => {} },
          state,
        );
        if (q.trim() === "[v1]" || q.trim() === "(special)" || q.trim() === "+") {
          assert.ok(html.includes("Model (special) [v1] + fast"));
        }
      }, `Query '${q}' must not cause regex crash`);
    }
  });

  it("CRITICAL: Active item preservation when active item does NOT match search query", () => {
    const models = Array.from({ length: 15 }, (_, i) =>
      model(`custom-${i + 1}`, { displayLabel: `Model Choice ${i + 1}` }),
    );
    const state = listed({ [modelsKey({ providerId: "codex" })]: models }, { [modelsKey({ providerId: "codex" })]: "providerCatalog" });

    // Active selected model is custom-1 ("Model Choice 1")
    // Filter query is "Choice 15" which ONLY matches custom-15
    const html = render(
      ModelPick,
      { value: "custom-1", scope: { providerId: "codex" }, filter: "Choice 15", onChange: () => {} },
      state,
    );

    // 1. Filter input rendered
    assert.ok(html.includes("<input"), "Filter input must be rendered for > 10 options");

    // 2. Active item "Model Choice 1" MUST be preserved and have aria-pressed="true"
    assert.ok(
      directlyPressed(html, "Model Choice 1"),
      "Active item 'Model Choice 1' MUST remain rendered with aria-pressed='true'",
    );

    // 3. Matched item "Model Choice 15" must be rendered (with aria-pressed="false")
    assert.ok(html.includes("Model Choice 15"), "Matched item 'Model Choice 15' must be rendered");
    assert.ok(
      !directlyPressed(html, "Model Choice 15"),
      "Matched item 'Model Choice 15' must NOT have aria-pressed='true'",
    );

    // 4. Unmatched items like "Model Choice 2" must NOT be rendered
    assert.ok(!html.includes("Model Choice 2<"), "Unmatched item 'Model Choice 2' must NOT be rendered");
    assert.ok(!html.includes("Model Choice 3<"), "Unmatched item 'Model Choice 3' must NOT be rendered");
  });

  it("CRITICAL: Active item preservation when selected item is Muse default (null)", () => {
    const museModels = Array.from({ length: 12 }, (_, i) =>
      model(`muse-model-${i + 1}`, { displayLabel: `Muse Model ${i + 1}` }),
    );
    const state = listed({ default: museModels }, { default: "bundledCatalog" });

    // Active selected is null (Muse default)
    // Filter is "model-12" (matches only muse-model-12)
    const html = render(
      ModelPick,
      { value: null, filter: "model-12", full: true, onChange: () => {} },
      state,
    );

    // Muse default button MUST remain rendered with aria-pressed="true"
    const hasMuseDefaultPressed =
      html.includes('aria-pressed="true"') &&
      (html.includes("Muse default") || html.includes("Muse&#x27;s default"));
    assert.ok(
      hasMuseDefaultPressed,
      "Muse default button must remain rendered and aria-pressed='true' even when filter excludes it",
    );
    assert.ok(html.includes("Muse Model 12"), "Filtered match 'Muse Model 12' must be rendered");
    assert.ok(!html.includes("Muse Model 2<"), "Unmatched models must be filtered out");
  });
});

// ============================================================================
// 3. ModelPick Fallback & NO_CHOICE Logic
// ============================================================================

describe("ModelPick empirical stress test - fallback for off-catalog / unknown models and NO_CHOICE", () => {
  it("value: null selects Muse default when catalog is ready", () => {
    const models = [
      model("muse-spark-1.3", { isDefault: true }),
      model("muse-wonder-1.0"),
    ];
    const state = listed({ default: models }, { default: "providerCatalog" });

    // With value: null and full: true, Muse default should be selected
    const html = render(ModelPick, { value: null, full: true, onChange: () => {} }, state);
    const hasMuseDefaultPressed =
      html.includes('aria-pressed="true"') &&
      (html.includes("Muse default") || html.includes("Muse&#x27;s default"));
    assert.ok(hasMuseDefaultPressed, "value: null must select Muse default button");
  });

  it("off-catalog / unknown model with catalog loading: NO_CHOICE prevents false selection of Muse default", () => {
    // When catalog is loading (not ready) and models is empty:
    // modelChoices does NOT create a pin row.
    // options only has the Default row with value: null.
    // If picked defaulted to null instead of NO_CHOICE ("\u0000"),
    // the Default row would falsely be selected (aria-pressed="true")!
    const loadingStatus: ModelsStatus = { status: "loading", error: null, loadedAt: null, catalog: null };
    const state: Partial<AppState> = {
      models: [],
      accountModels: { default: [] },
      modelsStatus: { default: loadingStatus },
    };

    const html = render(
      ModelPick,
      { value: "unknown-off-catalog-model-xyz", full: true, onChange: () => {} },
      state,
    );

    // CRITICAL: Muse default button (value: null) MUST NOT have aria-pressed="true"
    const museDefaultSelected =
      /aria-pressed="true"[^>]*>Muse(?:'s|&#x27;s)? default</i.test(html) ||
      /aria-pressed="true"[^>]*>Default</i.test(html);
    assert.ok(
      !museDefaultSelected,
      "CRITICAL: Unknown model during loading must NOT falsely cause Muse default to have aria-pressed='true'",
    );

    // Verify NO button has aria-pressed="true"
    assert.ok(
      !html.includes('aria-pressed="true"'),
      "When model is unknown and not in options, NO button should have aria-pressed='true'",
    );
  });

  it("off-catalog / unknown model when catalog is ready: pinned row is selected, Muse default is NOT selected", () => {
    const models = [
      model("muse-spark-1.3", { isDefault: true, displayLabel: "Muse Spark 1.3" }),
      model("muse-wonder-1.0", { displayLabel: "Muse Wonder 1.0" }),
    ];
    const state = listed({ default: models }, { default: "providerCatalog" });

    const html = render(
      ModelPick,
      { value: "completely-unknown-off-catalog-model-xyz", full: true, onChange: () => {} },
      state,
    );

    // CRITICAL: Muse default button (value: null) MUST NOT be selected!
    const museDefaultSelected =
      /aria-pressed="true"[^>]*>Muse(?:'s|&#x27;s)? default</i.test(html) ||
      /aria-pressed="true"[^>]*>Default</i.test(html);
    assert.ok(
      !museDefaultSelected,
      "CRITICAL: Unknown model must NOT falsely cause Muse default to have aria-pressed='true'",
    );

    // Pinned button for the unknown model is selected
    assert.ok(
      html.includes('aria-pressed="true"'),
      "Pinned model row for the off-catalog model is selected",
    );
    assert.ok(
      html.includes("completely-unknown-off-catalog-model-xyz"),
      "Pinned model name is displayed",
    );
  });

  it("unknown model with empty catalog status ready: NO_CHOICE prevents false selection of Muse default", () => {
    const state = listed({ default: [] }, { default: "bundledCatalog" });
    const html = render(
      ModelPick,
      { value: "unknown-model-abc", full: true, onChange: () => {} },
      state,
    );

    const museDefaultSelected = /aria-pressed="true"[^>]*>Muse(?:'s|&#x27;s)? default</i.test(html);
    assert.ok(
      !museDefaultSelected,
      "Empty catalog with unknown model must NOT highlight Muse default",
    );
  });

  it("known model in options is properly selected and highlighted", () => {
    const models = [
      model("muse-spark-1.3", { isDefault: true, displayLabel: "Muse Spark 1.3" }),
      model("muse-wonder-1.0", { displayLabel: "Muse Wonder 1.0" }),
    ];
    const state = listed({ default: models }, { default: "providerCatalog" });

    const html = render(
      ModelPick,
      { value: "muse-wonder-1.0", full: true, onChange: () => {} },
      state,
    );
    assert.ok(
      directlyPressed(html, "Muse Wonder 1.0"),
      "Known model in options must have aria-pressed='true'",
    );
    assert.ok(
      !/aria-pressed="true"[^>]*>Muse(?:'s|&#x27;s)? default</i.test(html),
      "Muse default must not be pressed when specific model is selected",
    );
  });
});

// ============================================================================
// 4. ModelPick Empirical Stress Test - React State Purity, Edge Case Filtering & Zero V8 Warnings
// ============================================================================

describe("ModelPick empirical stress test - React state purity, edge case filtering & zero V8 warnings", () => {
  it("whitespace-only query in filter does not filter out options when options > 10", () => {
    const models = Array.from({ length: 12 }, (_, i) =>
      model(`opt-${i + 1}`, { displayLabel: `Stress Model ${i + 1}` }),
    );
    const state = listed(
      { [modelsKey({ providerId: "claude" })]: models },
      { [modelsKey({ providerId: "claude" })]: "providerCatalog" },
    );

    // Whitespace-only filter '   ' should trim to '' and leave all 13 options visible (12 models + default)
    const html = render(
      ModelPick,
      { value: "opt-1", scope: { providerId: "claude" }, filter: "   ", onChange: () => {} },
      state,
    );
    assert.ok(html.includes("<input"), "Input rendered for > 10 options");
    for (const m of models) {
      assert.ok(html.includes(m.displayLabel!), `All options must remain visible when query is whitespace: ${m.displayLabel}`);
    }
  });

  it("query with no matches preserves the active option only, filtering out all others", () => {
    const models = Array.from({ length: 12 }, (_, i) =>
      model(`opt-${i + 1}`, { displayLabel: `Standard Model ${i + 1}` }),
    );
    const state = listed(
      { [modelsKey({ providerId: "gemini" })]: models },
      { [modelsKey({ providerId: "gemini" })]: "providerCatalog" },
    );

    const html = render(
      ModelPick,
      { value: "opt-5", scope: { providerId: "gemini" }, filter: "completely-unmatched-string-xyz", onChange: () => {} },
      state,
    );
    assert.ok(html.includes("Standard Model 5"), "Active option 'Standard Model 5' MUST be preserved despite not matching filter");
    assert.ok(html.includes('aria-pressed="true"'), "Active option must remain selected with aria-pressed='true'");
    assert.ok(!html.includes("Standard Model 1<"), "Non-matching 'Standard Model 1' must be filtered out");
    assert.ok(!html.includes("Standard Model 2<"), "Non-matching 'Standard Model 2' must be filtered out");
  });

  it("asymmetric accountModels key normalization does not mutate original state", () => {
    const models = [model("m-1", { displayLabel: "Scoped M1" })];
    // Test that unprefixed "codex:default" is normalized to "prov:codex:default"
    const rawAccountModels: Record<string, ModelOption[]> = Object.freeze({
      "codex:default": models,
    });
    const state: Partial<AppState> = {
      models: [],
      accountModels: rawAccountModels,
      modelsStatus: { "codex:default": ready(catalog("providerCatalog")) },
    };

    // Render with scope providerId: "codex" which uses modelsKey -> "prov:codex:default"
    const html = render(
      ModelPick,
      { value: "m-1", scope: { providerId: "codex" }, onChange: () => {} },
      state,
    );
    assert.ok(html.includes("Scoped M1"), "Should resolve models under 'prov:codex:default' from 'codex:default'");
    assert.ok(!("prov:codex:default" in rawAccountModels), "Original frozen accountModels must not be mutated");
  });

  it("100 rapid renders under varied state and filter parameters execute cleanly without V8 warnings", () => {
    const warnings: unknown[] = [];
    const warningListener = (w: unknown) => warnings.push(w);
    process.on("warning", warningListener);

    try {
      for (let i = 0; i < 100; i++) {
        const count = 5 + (i % 20); // 5 to 24 options
        const models = Array.from({ length: count }, (_, j) =>
          model(`rapid-${j}`, { displayLabel: `Rapid ${j}` }),
        );
        const state = listed(
          { default: models },
          { default: "providerCatalog" },
        );
        const filter = i % 3 === 0 ? "rapid" : i % 3 === 1 ? "nonexistent" : "";
        const val = i % 2 === 0 ? `rapid-${i % count}` : null;

        const html = render(
          ModelPick,
          { value: val, full: true, filter, onChange: () => {} },
          state,
        );
        assert.ok(html.length > 0, "Render output must be non-empty");
      }
      assert.strictEqual(warnings.length, 0, "Zero Node.js process warnings must occur during rapid renders");
    } finally {
      process.off("warning", warningListener);
    }
  });
});

