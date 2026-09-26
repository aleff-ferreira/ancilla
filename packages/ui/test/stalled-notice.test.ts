import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StalledNotice } from "../src/components/requests/Requests.js";

function render(historySync?: { checkedAt: number; progressAt: number | null }, busy = false): string {
  return renderToStaticMarkup(createElement(StalledNotice, { historySync, busy, onRetry: () => undefined }));
}

describe("StalledNotice", () => {
  it("distinguishes automatic saved-progress recovery from restored live updates", () => {
    const markup = render({ checkedAt: 1_790_395_260_000, progressAt: null });
    assert.match(markup, /Syncing saved progress/);
    assert.match(markup, /Muse’s live feed is unavailable\. Ancilla checks saved progress automatically without resending your task\./);
    assert.match(markup, /Reload results/);
    assert.match(markup, /Last checked/);
    assert.doesNotMatch(markup, /This thread stopped receiving updates|Progress updated|spin-ring/);
  });

  it("retains the warning and manual reload when automatic recovery is not active", () => {
    const markup = render();
    assert.match(markup, /This thread stopped receiving updates/);
    assert.match(markup, /Muse may still be working, or may already have finished/);
    assert.match(markup, /Reload results/);
    assert.doesNotMatch(markup, /Syncing saved progress|Last checked|Progress updated/);
  });

  it("shows reported progress separately from a later check, without announcing every timestamp change", () => {
    const progressAt = 1_790_395_200_000;
    const checkedAt = progressAt + 60_000;
    const markup = render({ checkedAt, progressAt });
    assert.match(markup, /Progress updated/);
    assert.ok(markup.includes(`dateTime="${new Date(checkedAt).toISOString()}"`));
    assert.ok(markup.includes(`dateTime="${new Date(progressAt).toISOString()}"`));
    assert.match(markup, /<p role="status"[^>]*>Syncing saved progress<\/p>/);
  });

  it("keeps the reload action disabled while its request is in progress", () => {
    const markup = render({ checkedAt: 1_790_395_260_000, progressAt: null }, true);
    assert.match(markup, /disabled=""/);
    assert.match(markup, /aria-busy="true"/);
    assert.match(markup, /Reload results/);
  });
});
