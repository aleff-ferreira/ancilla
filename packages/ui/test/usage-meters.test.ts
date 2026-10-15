import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { ContextMeter, ContextPanel } from "../src/components/composer/ContextPanel.js";
import { CostMeter } from "../src/components/composer/CostPanel.js";
import { GoalPanel } from "../src/components/thread/GoalPanel.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import { parseModelList } from "../src/client.js";
import type { AncillaController } from "../src/model/controller.js";
import { applyEvents, emptyFold, type ThreadFold } from "../src/model/fold.js";
import { defaultPrefs, initialState, Store, type AppState, type ThreadState } from "../src/model/store.js";
import type { ModelOption, ViewEvent } from "../src/types.js";
import { historyEvents, modelList } from "./fixtures/probe.js";

/**
 * The composer's chips and the goal card, server-rendered. The panels behind them open in portals and cannot be
 * seen here, but the chips and the goal card read the same `truncated` flag and the same figures, so a dropped
 * argument shows up in them.
 */

function thread(fold: ThreadFold, truncated = false): ThreadState {
  return { load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated, fold, attachments: [], shellRuns: [], researchRuns: [], stalled: false };
}

function render<P extends { sessionId: string }>(Component: ComponentType<P>, props: P, state: Partial<AppState>): string {
  const store = new Store<AppState>({ ...initialState(defaultPrefs("2026-09-28T00:00:00.000Z")), ...state });
  const controller = { store, setCardOpen() {}, setCardHidden() {} } as unknown as AncillaController;
  return renderToStaticMarkup(
    createElement(ControllerProvider, {
      controller,
      children: createElement(TooltipProvider, { children: createElement(Component, props) }),
    }),
  );
}

const call = (params: Record<string, unknown>, cursor = "v:1"): ViewEvent => ({
  method: "session/tokenUsage",
  params: { sessionId: "s1", turnId: "t1", viewCursor: cursor, ...params },
});

const WINDOWED: ModelOption = {
  modelId: "windowed",
  displayLabel: "windowed",
  description: null,
  isDefault: false,
  isActive: false,
  contextLimit: 1_000_000,
  outputLimit: null,
  cost: null,
  contributor: false,
};

/** A million prompt tokens on Muse Spark: $1.25 at the published rate, with nothing else to add. */
const SPEND = call({ modelId: "muse-spark-1.3", promptTokens: 1_000_000, usage: { outputTokens: 0 } });

describe("the composer's cost chip", () => {
  const chip = (state: Partial<AppState>) => render(CostMeter, { sessionId: "s1" }, state);

  it("reads exact on a whole thread and as a floor on a truncated one", () => {
    const fold = applyEvents(emptyFold(), [SPEND]);
    assert.match(chip({ threads: { s1: thread(fold) } }), /aria-label="Thread cost \$1\.25"/);
    assert.match(chip({ threads: { s1: thread(fold, true) } }), /aria-label="Thread cost ≥ \$1\.25"/);
  });

  it("reads as a floor when Muse's totals say earlier turns exist", () => {
    const models = parseModelList(modelList);
    const whole = applyEvents(emptyFold(), historyEvents);
    const tail = applyEvents(emptyFold(), historyEvents.slice(-12));
    assert.doesNotMatch(chip({ models, threads: { s1: thread(whole) } }), /Thread cost ≥/);
    assert.match(chip({ models, threads: { s1: thread(tail) } }), /Thread cost ≥ \$/);
  });

  it("reads as a floor when a subagent's spend is left out", () => {
    const agent: ViewEvent = {
      method: "item/completed",
      params: { item: { itemId: "s1", kind: "subagent", status: "completed", revision: 1, role: "explorer", usage: { inputTokens: 500_000, outputTokens: 20_000 } } },
    };
    assert.match(chip({ threads: { s1: thread(applyEvents(emptyFold(), [SPEND, agent])) } }), /Thread cost ≥ \$1\.25/);
  });

  it("writes a floor the same way when a call had no price, not as a plus", () => {
    const unpriced = call({ modelId: "muse-wonder-full-1.0", promptTokens: 1000, usage: { outputTokens: 100 } }, "v:2");
    const html = chip({ threads: { s1: thread(applyEvents(emptyFold(), [SPEND, unpriced])) } });
    assert.match(html, /aria-label="Thread cost ≥ \$1\.25"/);
    assert.match(html, />≥ \$1\.25<\/button>/);
    assert.doesNotMatch(html, /\$1\.25\+/);
  });

  it("is absent when nothing was priced", () => {
    const fold = applyEvents(emptyFold(), [call({ promptTokens: 1000, usage: { outputTokens: 100 } })]);
    assert.equal(chip({ threads: { s1: thread(fold) } }), "");
  });
});

describe("the composer's context ring", () => {
  const ring = (state: Partial<AppState>) => render(ContextMeter, { sessionId: "s1" }, state);

  it("stays, with the tokens in context, when the model's window is not known", () => {
    const fold = applyEvents(emptyFold(), [call({ modelId: "muse-spark-1.3", promptTokens: 1000, usage: { outputTokens: 100 } })]);
    const html = ring({ models: [], threads: { s1: thread(fold) } });
    assert.match(html, /aria-label="Context window, 1\.1k tokens in context"/);
    assert.match(html, />1\.1k<\/button>/);
  });

  it("shows an estimate from the last call as one, sized by the catalog window", () => {
    const fold = applyEvents(emptyFold(), [call({ modelId: "windowed", promptTokens: 250_000, usage: { outputTokens: 0 } })]);
    const html = ring({ models: [WINDOWED], threads: { s1: thread(fold) } });
    assert.match(html, /aria-label="Context window 25% used, estimated"/);
    assert.match(html, />25%<\/button>/);
  });

  it("takes Muse's own reading untouched", () => {
    const fold = applyEvents(emptyFold(), [{ method: "session/contextUsage", params: { usedTokens: 5000, windowTokens: 10_000, pressure: "warning" } }]);
    const html = ring({ threads: { s1: thread(fold) } });
    assert.match(html, /aria-label="Context window 50% used"/);
    assert.match(html, /text-warn/);
  });
});

describe("the context panel's cost", () => {
  const RATED = (modelId: string): ModelOption => ({ ...WINDOWED, modelId, displayLabel: modelId, cost: { input: 2, output: 8, cached: 0.5, currency: "USD" } });
  const models = [RATED("rate-a"), RATED("rate-b")];
  /** $0.0348 on one model and $0.0028 on the other: $0.0376 in all. */
  const calls = [
    call({ modelId: "rate-a", promptTokens: 10_000, usage: { outputTokens: 1_850 } }, "v:1"),
    call({ modelId: "rate-b", promptTokens: 1_000, usage: { outputTokens: 100 } }, "v:2"),
  ];
  const panel = (events: ViewEvent[], truncated = false) =>
    render(ContextPanel, { sessionId: "s1" }, { models, threads: { s1: thread(applyEvents(emptyFold(), events), truncated) } });

  it("prints the session cost and each model's cost the way the chip and the Usage page do", () => {
    const html = panel(calls);
    // Two decimals would read $0.04, $0.03 and $0.0028.
    assert.match(html, />≈\$0\.038<\/span>/);
    assert.match(html, />\$0\.035<\/span>/);
    assert.match(html, />\$0\.0028<\/span>/);
    assert.doesNotMatch(html, /\$0\.04\b|\$0\.03\b/);
  });

  it("marks a floor with the chip's own mark, for a call with no price and for cut-short history", () => {
    const unpriced = panel([...calls, call({ modelId: "muse-wonder-full-1.0", promptTokens: 1000, usage: { outputTokens: 100 } }, "v:3")]);
    assert.match(unpriced, />≥ \$0\.038<\/span>/);
    assert.doesNotMatch(unpriced, /≥\$|≈\$0\.038/);
    assert.match(panel(calls, true), />≥ \$0\.038<\/span>/);
  });

  it("marks a floor when a subagent's spend is left out, as the chip does", () => {
    const agent: ViewEvent = {
      method: "item/completed",
      params: { item: { itemId: "s1", kind: "subagent", status: "completed", revision: 1, role: "explorer", usage: { inputTokens: 500_000, outputTokens: 20_000 } } },
    };
    const html = panel([...calls, agent]);
    assert.match(html, />≥ \$0\.038<\/span>/);
    assert.doesNotMatch(html, /≈\$0\.038/);
  });
});

describe("the goal card", () => {
  const goalProps = { sessionId: "s1", running: false, readOnly: true };
  const T0 = Date.parse("2026-09-11T19:00:00.000Z");
  const LATE = T0 + 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const record = JSON.stringify({
    goal: {
      goal_id: "g1",
      objective: "Ship the release",
      status: "active",
      percent_complete: 10,
      current_work: null,
      next_work: null,
      created_at_ms: T0,
      updated_at_ms: T0,
      last_progress_at_ms: null,
      tokens_used: 0,
      token_budget: 500_000,
    },
  });
  /** An hour into the goal, a window that begins with the turn that asked Muse for it again. */
  const fold = (modelId = "muse-spark-1.3") =>
    applyEvents(emptyFold(), [
      { method: "item/completed", params: { item: { itemId: "u2", kind: "userMessage", status: "completed", revision: 1, turnId: "t2", text: "go", recordedAt: iso(LATE) } } },
      {
        method: "item/completed",
        params: { item: { itemId: "g-get", kind: "toolCall", status: "completed", revision: 1, turnId: "t2", tool: "get_goal", args: "{}", visibleOutput: record, recordedAt: iso(LATE + 1000) } },
      },
      call({ turnId: "t2", modelId, promptTokens: 7000, usage: { inputTokens: 7000, outputTokens: 300 } }, "c2"),
    ]);

  it("marks the cost and the tokens as floors when the history is cut short after the goal began", () => {
    const html = render(GoalPanel, goalProps, { threads: { s1: thread(fold(), true) } });
    assert.match(html, /<dd[^>]*>≥ \$0\.01\d*<\/dd>/);
    assert.match(html, /<dd[^>]*>≥ 7\.3k of 500k<\/dd>/);
  });

  it("prints them plainly when the whole history is loaded", () => {
    const html = render(GoalPanel, goalProps, { threads: { s1: thread(fold()) } });
    assert.match(html, /<dd[^>]*>\$0\.01\d*<\/dd>/);
    assert.match(html, /<dd[^>]*>7\.3k of 500k<\/dd>/);
    assert.doesNotMatch(html, /≥/);
  });

  it("prints a dash, not a zero floor, when the goal ran on a model Meta does not price", () => {
    const html = render(GoalPanel, goalProps, { threads: { s1: thread(fold("muse-wonder-full-1.0")) } });
    assert.match(html, /<dt[^>]*>Cost<\/dt><dd[^>]*>—<\/dd>/);
    assert.doesNotMatch(html, /≥ \$0\b/);
    // The tokens are still counted, and the dash is not read as a zero.
    assert.match(html, /<dd[^>]*>7\.3k of 500k<\/dd>/);
  });
});
