import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STREAM_SAMPLE_LIMIT,
  STREAM_SAMPLE_MS,
  STREAM_WORD_LIMIT,
  streamRenderMode,
  type StreamRenderMode,
} from "../src/model/streaming.js";

describe("streamRenderMode dynamic layout policy", () => {
  interface RenderModeVector {
    readonly description: string;
    readonly characterCount: number;
    readonly isStreamingActive: boolean;
    readonly targetMode: StreamRenderMode;
  }

  const RENDER_VECTORS: readonly RenderModeVector[] = [
    { description: "zero characters when inactive", characterCount: 0, isStreamingActive: false, targetMode: "static" },
    { description: "small length when inactive", characterCount: 450, isStreamingActive: false, targetMode: "static" },
    { description: "exact word boundary when inactive", characterCount: STREAM_WORD_LIMIT, isStreamingActive: false, targetMode: "static" },
    { description: "sample boundary when inactive", characterCount: STREAM_SAMPLE_LIMIT, isStreamingActive: false, targetMode: "static" },
    { description: "massive document when inactive", characterCount: STREAM_SAMPLE_LIMIT + 2_500_000, isStreamingActive: false, targetMode: "static" },
    { description: "active stream start at zero", characterCount: 0, isStreamingActive: true, targetMode: "words" },
    { description: "active stream beneath word limit", characterCount: 1_200, isStreamingActive: true, targetMode: "words" },
    { description: "active stream exactly at word limit", characterCount: STREAM_WORD_LIMIT, isStreamingActive: true, targetMode: "words" },
    { description: "active stream immediately past word limit", characterCount: STREAM_WORD_LIMIT + 1, isStreamingActive: true, targetMode: "plain" },
    { description: "active stream mid-way between limits", characterCount: 20_000, isStreamingActive: true, targetMode: "plain" },
    { description: "active stream exactly at sample limit", characterCount: STREAM_SAMPLE_LIMIT, isStreamingActive: true, targetMode: "plain" },
    { description: "active stream immediately past sample limit", characterCount: STREAM_SAMPLE_LIMIT + 1, isStreamingActive: true, targetMode: "sampled" },
    { description: "high-volume output generation", characterCount: 75_000, isStreamingActive: true, targetMode: "sampled" },
    { description: "very large document streams", characterCount: 15_000_000, isStreamingActive: true, targetMode: "sampled" },
  ];

  for (const { description, characterCount, isStreamingActive, targetMode } of RENDER_VECTORS) {
    it(`evaluates ${description} as "${targetMode}"`, () => {
      const mode = streamRenderMode(characterCount, isStreamingActive);
      assert.strictEqual(mode, targetMode, `Expected ${targetMode} for len=${characterCount}, active=${isStreamingActive}`);
    });
  }

  describe("streaming threshold configuration constants", () => {
    it("preserves established performance threshold invariants", () => {
      assert.strictEqual(STREAM_WORD_LIMIT, 10_000, "word animation boundary");
      assert.strictEqual(STREAM_SAMPLE_LIMIT, 30_000, "sampled snapshot boundary");
      assert.strictEqual(STREAM_SAMPLE_MS, 500, "sampling throttle interval");
      assert.ok(STREAM_WORD_LIMIT < STREAM_SAMPLE_LIMIT, "word threshold must be strictly below sample threshold");
    });
  });
});
