/**
 * Loading the speech models before a call, from a pointer over the Talk button: asked only when the voice is installed,
 * not more than once in a couple of minutes, and never a source of an error on the page.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { forgetWarmth, warmVoice, type WarmTarget } from "../src/components/voice/warm.js";

function target(options: { hasVoice?: boolean; fails?: boolean } = {}): WarmTarget & { calls: string[] } {
  const calls: string[] = [];
  return {
    hasVoice: options.hasVoice ?? true,
    calls,
    voice: (method, path) => {
      calls.push(`${method} ${path}`);
      return options.fails ? Promise.reject(new Error("the server is not there")) : Promise.resolve({ warming: true });
    },
  };
}

describe("warming the voice before a call", () => {
  beforeEach(() => forgetWarmth());

  it("asks the server to load the models when the voice is installed", () => {
    const t = target();
    assert.equal(warmVoice(t, true, 1_000_000), true);
    assert.deepEqual(t.calls, ["POST /warm"]);
  });

  it("asks nothing when the voice is not installed, is not known yet, or this client has none", () => {
    const t = target();
    assert.equal(warmVoice(t, false, 1_000_000), false);
    assert.equal(warmVoice(t, null, 1_000_000), false);
    assert.equal(warmVoice(target({ hasVoice: false }), true, 1_000_000), false);
    assert.deepEqual(t.calls, []);
  });

  it("asks once in a couple of minutes, not on every pass of the pointer", () => {
    const t = target();
    assert.equal(warmVoice(t, true, 1_000_000), true);
    assert.equal(warmVoice(t, true, 1_000_500), false);
    assert.equal(warmVoice(t, true, 1_000_000 + 119_000), false);
    assert.equal(warmVoice(t, true, 1_000_000 + 121_000), true, "and again once the models may have been let go");
    assert.equal(t.calls.length, 2);
  });

  it("is never an error on the page, even when the server is not there", async () => {
    const t = target({ fails: true });
    assert.equal(warmVoice(t, true, 1_000_000), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(t.calls, ["POST /warm"], "it asked, was refused, and nothing was thrown or left unhandled");
  });
});
