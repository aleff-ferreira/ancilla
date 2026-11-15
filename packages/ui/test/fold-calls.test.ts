import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvents, emptyFold, foldFromLoad, type ThreadFold } from "../src/model/fold.js";
import { sessionTelemetry, sessionUsage } from "../src/model/usage.js";
import type { TranscriptLoad, ViewEvent } from "../src/types.js";
import { historyEvents, liveEvents } from "./fixtures/probe.js";

/**
 * The probe fixtures hold one real thread twice: the live stream and the history page that replays it. Both carry
 * the same five model calls, numbered with different view cursors (the page drops the deltas between them), so a
 * call is only counted once if it is keyed by something both spell the same way.
 */
const CALLS = 5;

const live = (): ThreadFold => applyEvents(emptyFold(), liveEvents);
const history = (): ThreadFold => applyEvents(emptyFold(), historyEvents);

/** A history read whose projection is unavailable: the partial path, which merges the saved calls with the live ones. */
function unavailable(events: ViewEvent[]): TranscriptLoad {
  return {
    session: null, msp: null, events, truncated: false, historyUnavailable: true,
    viewHealth: { status: "unavailable", reason: "projectionUnavailable" },
    pending: { approvals: [], userInputs: [] }, readOnly: false, readOnlyReason: null,
  };
}

function callCount(fold: ThreadFold): number {
  return Object.keys(fold.meta.calls).length;
}

function usageEvent(cursor: string | undefined, params: Record<string, unknown>): ViewEvent {
  return { method: "session/tokenUsage", params: { sessionId: "s1", turnId: "t1", ...(cursor ? { viewCursor: cursor } : {}), ...params } };
}

describe("one model call is one entry, whichever way it arrived", () => {
  it("has five calls in each fixture on its own, under cursors that do not match", () => {
    assert.equal(callCount(live()), CALLS);
    assert.equal(callCount(history()), CALLS);
    const liveCursors = liveEvents.filter((event) => event.method === "session/tokenUsage").map((event) => event.params["viewCursor"]);
    const historyCursors = historyEvents.filter((event) => event.method === "session/tokenUsage").map((event) => event.params["viewCursor"]);
    assert.notDeepEqual(liveCursors, historyCursors, "the premise: the same calls sit at different cursors");
  });

  it("does not double the calls when a history read merges with the live fold", () => {
    const merged = foldFromLoad(unavailable(historyEvents), live());
    assert.equal(callCount(merged), CALLS);
    assert.equal(sessionUsage(merged, []).calls, CALLS);
    const t = sessionTelemetry(merged);
    const single = sessionTelemetry(live());
    assert.equal(t.steps, CALLS);
    assert.equal(t.durationMs, 38_858);
    assert.equal(t.durationMs, single.durationMs);
    assert.equal(t.reasoningTokens, 457);
    assert.equal(t.reasoningTokens, single.reasoningTokens);
    assert.equal(t.cachedTokens, single.cachedTokens);
  });

  it("does not double them when live events are applied over a history fold, or the other way round", () => {
    assert.equal(callCount(applyEvents(history(), liveEvents)), CALLS, "buffered live events over a fresh history fold");
    assert.equal(callCount(applyEvents(live(), historyEvents)), CALLS, "a history page over the live fold");
    const both = applyEvents(applyEvents(emptyFold(), liveEvents), historyEvents);
    assert.equal(sessionTelemetry(both).steps, CALLS);
    assert.equal(sessionTelemetry(both).durationMs, 38_858);
  });

  it("counts a replayed history once", () => {
    const twice = applyEvents(history(), historyEvents);
    assert.equal(callCount(twice), CALLS);
    assert.deepEqual(twice.meta.calls, history().meta.calls);
  });

  it("keeps two calls of one turn apart when their running totals differ", () => {
    const fold = applyEvents(emptyFold(), [
      usageEvent("a", { promptTokens: 100, durationMs: 1000, usage: { outputTokens: 10 }, cumulative: { promptTokens: 100, outputTokens: 10, totalTokens: 110 } }),
      usageEvent("b", { promptTokens: 150, durationMs: 1000, usage: { outputTokens: 10 }, cumulative: { promptTokens: 250, outputTokens: 20, totalTokens: 270 } }),
    ]);
    assert.equal(callCount(fold), 2);
    assert.equal(sessionTelemetry(fold).steps, 2);
  });

  it("keeps two zero-token calls of one turn apart when their model times differ", () => {
    const totals = { promptTokens: 100, outputTokens: 10, totalTokens: 110 };
    const fold = applyEvents(emptyFold(), [
      usageEvent("a", { promptTokens: 0, durationMs: 400, usage: { outputTokens: 0 }, cumulative: totals }),
      usageEvent("b", { promptTokens: 0, durationMs: 900, usage: { outputTokens: 0 }, cumulative: totals }),
    ]);
    assert.equal(callCount(fold), 2);
  });

  it("keeps the same totals in two turns apart", () => {
    const totals = { promptTokens: 100, outputTokens: 10, totalTokens: 110 };
    const fold = applyEvents(emptyFold(), [
      usageEvent("a", { turnId: "t1", promptTokens: 100, usage: { outputTokens: 10 }, cumulative: totals }),
      usageEvent("b", { turnId: "t2", promptTokens: 100, usage: { outputTokens: 10 }, cumulative: totals }),
    ]);
    assert.equal(callCount(fold), 2);
  });

  it("falls back to the view cursor when an event carries no running totals", () => {
    const fold = applyEvents(emptyFold(), [
      usageEvent("v:1", { promptTokens: 100, usage: { outputTokens: 10 } }),
      usageEvent("v:2", { promptTokens: 100, usage: { outputTokens: 10 } }),
      usageEvent("v:2", { promptTokens: 100, usage: { outputTokens: 10 } }),
    ]);
    assert.deepEqual(Object.keys(fold.meta.calls).sort(), ["v:1", "v:2"]);
    // An empty totals block says nothing either, so it does not collapse calls that only differ by cursor.
    const empty = applyEvents(emptyFold(), [
      usageEvent("v:1", { promptTokens: 100, usage: { outputTokens: 10 }, cumulative: {} }),
      usageEvent("v:2", { promptTokens: 100, usage: { outputTokens: 10 }, cumulative: {} }),
    ]);
    assert.equal(callCount(empty), 2);
  });
});
