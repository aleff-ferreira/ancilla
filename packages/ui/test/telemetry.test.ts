import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvents, emptyFold, type ThreadFold } from "../src/model/fold.js";
import {
  formatCompactTokens,
  formatDuration,
  formatExactTokens,
  formatTokensPerSecond,
} from "../src/model/format.js";
import {
  countedTurns,
  sessionTelemetry,
  sessionUsage,
  timePillLabel,
  turnSpeed,
  usagePillLabel,
} from "../src/model/usage.js";
import { SPEED_TIP } from "../src/model/usage-labels.js";
import type { ViewEvent } from "../src/types.js";
import { historyEvents } from "./fixtures/probe.js";

class TelemetryStreamFactory {
  private readonly events: ViewEvent[] = [];

  recordTurnStart(turnId: string): this {
    this.events.push({ method: "turn/started", params: { turnId } });
    return this;
  }

  recordTurnTerminal(turnId: string, terminal = "completed", durationMs = 0, firstTokenMs = 0): this {
    this.events.push({
      method: "turn/completed",
      params: { turnId, terminal, durationMs, timeToFirstTokenMs: firstTokenMs },
    });
    return this;
  }

  recordTurnRetraction(turnId: string): this {
    this.events.push({ method: "turn/retracted", params: { turnId } });
    return this;
  }

  recordTurnUnqueued(turnId: string): this {
    this.events.push({ method: "turn/unqueued", params: { turnId } });
    return this;
  }

  recordCallUsage(params: {
    turnId?: string;
    durationMs?: number;
    promptTokens?: number;
    modelId?: string;
    usage?: {
      outputTokens?: number;
      cachedTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
    };
    cumulative?: {
      promptTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  }): this {
    const idx = this.events.length;
    this.events.push({
      method: "session/tokenUsage",
      params: {
        sessionId: "sess-telemetry-harness",
        viewCursor: `cur:${idx}`,
        ...params,
      },
    });
    return this;
  }

  buildThreadFold(): ThreadFold {
    return applyEvents(emptyFold(), this.events);
  }
}

describe("session telemetry aggregation and metrics", () => {
  describe("cache efficiency analytics", () => {
    it("computes cache hit percentages without prompt overflow", () => {
      const stream = new TelemetryStreamFactory();
      stream
        .recordCallUsage({
          promptTokens: 1000,
          usage: { outputTokens: 100, cacheReadTokens: 900, cachedTokens: 100 },
        })
        .recordCallUsage({
          promptTokens: 100,
          usage: { outputTokens: 10, cachedTokens: 500 },
        });

      const telemetry = sessionTelemetry(stream.buildThreadFold());
      assert.strictEqual(telemetry.cachedTokens, 1000);
      assert.strictEqual(telemetry.cacheHitPct, 91);
    });

    it("preserves cache write tokens and reasoning token allocations", () => {
      const stream = new TelemetryStreamFactory();
      stream
        .recordCallUsage({
          promptTokens: 120_000,
          usage: { outputTokens: 15_000, cachedTokens: 90_000, reasoningTokens: 1_200 },
        })
        .recordCallUsage({
          usage: { outputTokens: 3_000, cacheWriteTokens: 6_000 },
        });

      const telemetry = sessionTelemetry(stream.buildThreadFold());
      assert.strictEqual(telemetry.promptTokens, 120_000);
      assert.strictEqual(telemetry.cachedTokens, 90_000);
      assert.strictEqual(telemetry.cacheWriteTokens, 6_000);
      assert.strictEqual(telemetry.reasoningTokens, 1_200);
      assert.strictEqual(telemetry.outputTokens, 18_000);
      assert.strictEqual(telemetry.cacheHitPct, 75);
    });

    it("keeps loaded cache counts separate from authoritative session totals", () => {
      const stream = new TelemetryStreamFactory();
      stream.recordCallUsage({
        promptTokens: 1200,
        usage: { outputTokens: 100, cachedTokens: 900 },
        cumulative: { promptTokens: 12000, outputTokens: 1000, totalTokens: 13000 },
      });

      const telemetry = sessionTelemetry(stream.buildThreadFold());
      assert.strictEqual(telemetry.totalTokens, 13000);
      assert.strictEqual(telemetry.uncachedTokens, 300);
      assert.strictEqual(telemetry.cachedTokens, 900);
      assert.strictEqual(telemetry.cacheHitPct, 75);
      assert.strictEqual(usagePillLabel(telemetry), "13K tok");
    });
  });

  describe("partial transcript and tail-loading handling", () => {
    it("preserves cumulative session totals when evaluating a truncated tail slice", () => {
      const completeFold = applyEvents(emptyFold(), historyEvents);
      const wholeTelemetry = sessionTelemetry(completeFold);

      const tailFold = applyEvents(emptyFold(), historyEvents.slice(-12));
      const tailTelemetry = sessionTelemetry(tailFold);

      assert.strictEqual(tailTelemetry.promptTokens, wholeTelemetry.promptTokens);
      assert.strictEqual(tailTelemetry.outputTokens, wholeTelemetry.outputTokens);
      assert.match(timePillLabel(tailTelemetry), /partial/i);
      assert.doesNotMatch(usagePillLabel(tailTelemetry), /Cache hit/);
      const loadedPrompt = Object.values(tailFold.meta.calls).reduce((sum, call) => sum + call.promptTokens, 0);
      assert.strictEqual(tailTelemetry.uncachedTokens + tailTelemetry.cachedTokens, loadedPrompt);
    });

    it("classifies telemetry as lower-bound when truncated history lacks cumulative aggregates", () => {
      const stream = new TelemetryStreamFactory();
      stream.recordCallUsage({
        promptTokens: 1000,
        usage: { outputTokens: 100, cachedTokens: 900 },
      });

      const telemetry = sessionTelemetry(stream.buildThreadFold(), true);
      assert.strictEqual(telemetry.partial, true);
      assert.strictEqual(telemetry.totalsComplete, false);
      assert.strictEqual(usagePillLabel(telemetry), "1.1K+ tok");
      assert.match(timePillLabel(telemetry), /Partial/);
    });

    it("displays authoritative token totals when call history is absent", () => {
      const fold = emptyFold();
      fold.meta.tokenTotals = { promptTokens: 850, outputTokens: 150, totalTokens: 1000 };

      const telemetry = sessionTelemetry(fold);
      assert.strictEqual(telemetry.partial, true);
      assert.strictEqual(telemetry.totalsComplete, true);
      assert.strictEqual(telemetry.steps, 0);
      assert.strictEqual(usagePillLabel(telemetry), "1K tok");
    });

    it("counts a turn the moment it starts and handles empty thread state", () => {
      const liveStream = new TelemetryStreamFactory();
      liveStream.recordTurnStart("t-live-1");
      const live = sessionTelemetry(liveStream.buildThreadFold());
      assert.strictEqual(live.turns, 1);
      assert.strictEqual(live.steps, 0);
      assert.strictEqual(live.tokensPerSecond, null);
      assert.strictEqual(live.cacheHitPct, null);

      const empty = sessionTelemetry(emptyFold());
      assert.strictEqual(empty.turns, 0);
      assert.strictEqual(empty.steps, 0);
      assert.deepStrictEqual(empty.models, []);
    });
  });

  describe("throughput velocity and model execution duration", () => {
    it("restricts tokens-per-second calculations exclusively to calls with reported duration", () => {
      const stream = new TelemetryStreamFactory();
      stream
        .recordTurnStart("turn-1")
        .recordCallUsage({ turnId: "turn-1", durationMs: 2000, usage: { outputTokens: 200 } })
        .recordCallUsage({ turnId: "turn-1", durationMs: 0, usage: { outputTokens: 500 } });

      const telemetry = sessionTelemetry(stream.buildThreadFold());
      assert.ok(Math.abs((telemetry.tokensPerSecond ?? 0) - 100) < 1e-9);
      assert.strictEqual(telemetry.timedCalls, 1);
      assert.strictEqual(telemetry.durationMs, 2000);
      assert.strictEqual(telemetry.steps, 2);
    });

    it("omits tiny token outputs from speed calculations while retaining recorded time", () => {
      const stream = new TelemetryStreamFactory();
      stream
        .recordTurnStart("turn-1")
        .recordCallUsage({ turnId: "turn-1", durationMs: 2500, usage: { outputTokens: 250 } })
        .recordCallUsage({ turnId: "turn-1", durationMs: 1500, usage: { outputTokens: 4 } });

      const telemetry = sessionTelemetry(stream.buildThreadFold());
      assert.ok(Math.abs((telemetry.tokensPerSecond ?? 0) - 100) < 1e-9);
      assert.strictEqual(telemetry.timedCalls, 2);
      assert.strictEqual(telemetry.durationMs, 4000);
    });

    it("reports no speed for a lone call timed at zero", () => {
      const stream = new TelemetryStreamFactory();
      stream.recordCallUsage({ turnId: "turn-zero", durationMs: 0, usage: { outputTokens: 400 } });

      const telemetry = sessionTelemetry(stream.buildThreadFold());
      assert.strictEqual(telemetry.tokensPerSecond, null);
      assert.strictEqual(telemetry.timedCalls, 0);
    });

    it("reconciles session speed with single-turn speed footer metrics", () => {
      const stream = new TelemetryStreamFactory();
      stream
        .recordTurnStart("turn-1")
        .recordCallUsage({ turnId: "turn-1", durationMs: 3000, usage: { outputTokens: 300 } })
        .recordCallUsage({ turnId: "turn-1", durationMs: 2000, usage: { outputTokens: 5 } })
        .recordCallUsage({ turnId: "turn-1", durationMs: 0, usage: { outputTokens: 400 } })
        .recordCallUsage({ turnId: "turn-1", durationMs: 1500, usage: { outputTokens: 150 } });

      const fold = stream.buildThreadFold();
      const turnMetrics = turnSpeed(fold, "turn-1");
      assert.ok(turnMetrics);
      assert.strictEqual(sessionTelemetry(fold).tokensPerSecond, turnMetrics.tokensPerSecond);
      assert.ok(Math.abs(turnMetrics.tokensPerSecond - (450 / 4500) * 1000) < 1e-9);
    });

    it("provides the canonical speed tooltip description string", () => {
      assert.match(SPEED_TIP, /^Output tokens including reasoning over model call time/);
    });
  });

  describe("telemetry and context panel agreement", () => {
    const buildMixedFold = () => {
      const factory = new TelemetryStreamFactory();
      factory
        .recordCallUsage({
          promptTokens: 1000,
          usage: { outputTokens: 100, cacheReadTokens: 900, cachedTokens: 100 },
        })
        .recordCallUsage({
          promptTokens: 100,
          usage: { outputTokens: 10, cachedTokens: 500 },
        });
      return factory.buildThreadFold();
    };

    const getTestFolds = () => [
      buildMixedFold(),
      applyEvents(emptyFold(), historyEvents),
      applyEvents(emptyFold(), historyEvents.slice(-12)),
      emptyFold(),
    ];

    it("reads cache metrics from equivalent underlying sums", () => {
      for (const fold of getTestFolds()) {
        const telemetry = sessionTelemetry(fold);
        const usage = sessionUsage(fold, []);
        assert.strictEqual(telemetry.cachedTokens, usage.cachedReadTokens);
        assert.strictEqual(telemetry.uncachedTokens, usage.freshTokens);
      }
      assert.strictEqual(sessionUsage(buildMixedFold(), []).cachedReadTokens, 1000);
    });

    it("evaluates load partial status identically across telemetry and context panel", () => {
      for (const fold of getTestFolds()) {
        for (const truncated of [false, true]) {
          assert.strictEqual(
            sessionTelemetry(fold, truncated).partial,
            sessionUsage(fold, [], truncated).partial,
          );
        }
      }
      assert.strictEqual(sessionTelemetry(applyEvents(emptyFold(), historyEvents)).partial, false);
      assert.strictEqual(sessionTelemetry(applyEvents(emptyFold(), historyEvents.slice(-12))).partial, true);
    });
  });

  describe("model breakdown and label formatting", () => {
    it("groups call counts by model identifier stripping contributor suffixes", () => {
      const stream = new TelemetryStreamFactory();
      stream
        .recordCallUsage({ modelId: "muse-spark-1.3", usage: { outputTokens: 300 } })
        .recordCallUsage({ modelId: "muse-spark-1.3", durationMs: 1000, usage: { outputTokens: 100 } })
        .recordCallUsage({ modelId: "muse-spark-1.3-contributor", usage: { outputTokens: 50 } });

      const telemetry = sessionTelemetry(stream.buildThreadFold());
      assert.deepStrictEqual(
        telemetry.models.map((m) => ({ name: m.name, calls: m.calls, output: m.outputTokens })),
        [
          { name: "muse-spark-1.3", calls: 2, output: 400 },
          { name: "muse-spark-1.3", calls: 1, output: 50 },
        ],
      );
    });

    it("labels time pills with turns, steps and speed metrics", () => {
      const timedStream = new TelemetryStreamFactory();
      timedStream
        .recordTurnStart("t1")
        .recordTurnStart("t2")
        .recordTurnStart("t3")
        .recordCallUsage({ turnId: "t1", durationMs: 1000, usage: { outputTokens: 100 } })
        .recordCallUsage({ turnId: "t1", durationMs: 1000, usage: { outputTokens: 24 } })
        .recordCallUsage({ turnId: "t2", usage: { outputTokens: 40 } })
        .recordCallUsage({ turnId: "t2", usage: { outputTokens: 40 } })
        .recordCallUsage({ turnId: "t2", usage: { outputTokens: 40 } })
        .recordCallUsage({ turnId: "t3", usage: { outputTokens: 40 } })
        .recordCallUsage({ turnId: "t3", usage: { outputTokens: 40 } })
        .recordCallUsage({ turnId: "t3", usage: { outputTokens: 40 } });

      const timed = sessionTelemetry(timedStream.buildThreadFold());
      assert.strictEqual(timePillLabel(timed), "3 turns · 8 steps · 62 tok/s");

      const untimedStream = new TelemetryStreamFactory();
      untimedStream
        .recordTurnStart("t1")
        .recordCallUsage({ turnId: "t1", usage: { outputTokens: 10 } })
        .recordCallUsage({ turnId: "t1", usage: { outputTokens: 10 } })
        .recordCallUsage({ turnId: "t1", usage: { outputTokens: 10 } })
        .recordCallUsage({ turnId: "t1", usage: { outputTokens: 10 } });

      const untimed = sessionTelemetry(untimedStream.buildThreadFold());
      assert.strictEqual(timePillLabel(untimed), "1 turn · 4 steps");

      const singleStream = new TelemetryStreamFactory();
      singleStream
        .recordTurnStart("t1")
        .recordCallUsage({ turnId: "t1", usage: { outputTokens: 10 } });

      const single = sessionTelemetry(singleStream.buildThreadFold());
      assert.strictEqual(timePillLabel(single), "1 turn · 1 step");
    });

    it("formats compact telemetry pill indicators with appropriate units and cache hit details", () => {
      const stream = new TelemetryStreamFactory();
      stream.recordCallUsage({
        promptTokens: 100_000,
        usage: { outputTokens: 152_000, cachedTokens: 87_000 },
      });

      const telemetry = sessionTelemetry(stream.buildThreadFold());
      assert.strictEqual(usagePillLabel(telemetry), "252K tok · Cache hit 87%");

      const uncachedStream = new TelemetryStreamFactory();
      uncachedStream.recordCallUsage({ usage: { outputTokens: 18_400 } });
      const uncached = sessionTelemetry(uncachedStream.buildThreadFold());
      assert.strictEqual(usagePillLabel(uncached), "18.4K tok");
    });
  });

  describe("turn counting and lifecycle rules", () => {
    it("excludes unqueued and retracted prompts from active turn tallies", () => {
      const stream = new TelemetryStreamFactory();
      stream
        .recordTurnStart("t1")
        .recordTurnTerminal("t1")
        .recordTurnUnqueued("t2")
        .recordTurnStart("t3")
        .recordTurnRetraction("t3");

      const fold = stream.buildThreadFold();
      assert.strictEqual(sessionTelemetry(fold).turns, 1);
      assert.strictEqual(sessionUsage(fold, []).turns, 1);
    });

    it("counts a retracted turn once even when marked as cancelled", () => {
      const stream = new TelemetryStreamFactory();
      stream
        .recordTurnStart("t1")
        .recordTurnTerminal("t1")
        .recordTurnStart("t3")
        .recordTurnRetraction("t3")
        .recordTurnTerminal("t3", "cancelled");

      const fold = stream.buildThreadFold();
      assert.strictEqual(sessionTelemetry(fold).turns, 1);
      assert.strictEqual(sessionUsage(fold, []).turns, 1);
    });

    it("computes duration and time-to-first-token solely from completed counted turns", () => {
      const stream = new TelemetryStreamFactory();
      stream
        .recordTurnStart("t1")
        .recordTurnTerminal("t1", "completed", 1000, 100)
        .recordTurnStart("t2")
        .recordTurnTerminal("t2", "completed", 3000, 300)
        .recordTurnStart("t3")
        .recordTurnTerminal("t3", "completed", 5000, 900)
        .recordTurnUnqueued("t3")
        .recordTurnStart("t4")
        .recordTurnRetraction("t4")
        .recordTurnTerminal("t4", "cancelled", 7000, 700);

      const usage = sessionUsage(stream.buildThreadFold(), []);
      assert.strictEqual(usage.turns, 2);
      assert.strictEqual(usage.workedMs, 4000);
      assert.strictEqual(usage.firstTokenMs, 200);
    });

    it("counts currently active running turns in the pill while panel reflects completed turns", () => {
      const stream = new TelemetryStreamFactory();
      stream
        .recordTurnStart("t1")
        .recordTurnTerminal("t1")
        .recordTurnStart("t2");

      const fold = stream.buildThreadFold();
      assert.strictEqual(sessionTelemetry(fold).turns, 2, "pill displays running + completed");
      assert.strictEqual(sessionUsage(fold, []).turns, 1, "panel displays completed only");
      assert.deepStrictEqual(
        countedTurns(fold).map((t) => t.turnId),
        ["t1", "t2"],
      );
    });
  });

  describe("number and duration string formatters", () => {
    it("formats velocity rates with one decimal under 100 and integer above", () => {
      assert.strictEqual(formatTokensPerSecond(62), "62 tok/s");
      assert.strictEqual(formatTokensPerSecond(7.25), "7.3 tok/s");
      assert.strictEqual(formatTokensPerSecond(125.4), "125 tok/s");
    });

    it("formats durations across millisecond, second, minute, and hour spans", () => {
      assert.strictEqual(formatDuration(820), "820ms");
      assert.strictEqual(formatDuration(42_000), "42s");
      assert.strictEqual(formatDuration(64_000), "1m 4s");
      assert.strictEqual(formatDuration(3_720_000), "1h 2m");
      assert.strictEqual(formatDuration(null), "");
    });

    it("formats exact counts with standard comma groupings", () => {
      assert.strictEqual(formatExactTokens(999), "999");
      assert.strictEqual(formatExactTokens(252_343), "252,343");
      assert.strictEqual(formatExactTokens(1_234_567), "1,234,567");
    });

    it("formats compact counts with metric prefixes", () => {
      assert.strictEqual(formatCompactTokens(364), "364");
      assert.strictEqual(formatCompactTokens(18_400), "18.4k");
      assert.strictEqual(formatCompactTokens(252_000), "252k");
    });
  });

  describe("telemetry preferences default state", () => {
    it("initializes telemetry visibility as disabled by default and respects persisted overrides", async () => {
      const { defaultPrefs, revivePrefs } = await import("../src/model/store.js");
      assert.strictEqual(defaultPrefs().showTelemetry, false);
      assert.strictEqual(revivePrefs({}, defaultPrefs()).showTelemetry, false);
      assert.strictEqual(revivePrefs({ showTelemetry: true }, defaultPrefs()).showTelemetry, true);
    });
  });
});
