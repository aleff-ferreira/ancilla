import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StalledNotice } from "../src/components/requests/Requests.js";

function mountStalledNoticeBanner(
  syncStatus?: { checkedAt: number; progressAt: number | null },
  isRequestActive = false,
): string {
  const componentProps = {
    historySync: syncStatus,
    busy: isRequestActive,
    onRetry: () => undefined,
  };
  return renderToStaticMarkup(createElement(StalledNotice, componentProps));
}

describe("StalledNotice Banner - Autonomous Saved-Progress Recovery", () => {
  it("displays non-destructive recovery status while poll checks proceed in background", () => {
    const epochCheck = 1_820_000_000_000;
    const htmlOutput = mountStalledNoticeBanner({ checkedAt: epochCheck, progressAt: null });

    assert.match(htmlOutput, /Syncing saved progress/);
    assert.match(
      htmlOutput,
      /Muse’s live feed is unavailable\. Ancilla checks saved progress automatically without resending your task\./,
    );
    assert.match(htmlOutput, /Reload results/);
    assert.match(htmlOutput, /Last checked/);
    assert.doesNotMatch(htmlOutput, /This thread stopped receiving updates|Progress updated|spin-ring/);
  });
});

describe("StalledNotice Banner - Unrecovered Inactive State", () => {
  it("surfaces stalled warning notice and manual reload control when automatic sync is inactive", () => {
    const rawNoticeHtml = mountStalledNoticeBanner();

    assert.match(rawNoticeHtml, /This thread stopped receiving updates/);
    assert.match(rawNoticeHtml, /Muse may still be working, or may already have finished/);
    assert.match(rawNoticeHtml, /Reload results/);
    assert.doesNotMatch(rawNoticeHtml, /Syncing saved progress|Last checked|Progress updated/);
  });
});

describe("StalledNotice Banner - Progress and Check Timestamps", () => {
  it("differentiates latest progress receipt timestamp from subsequent poll verification times", () => {
    const lastProgressMs = 1_819_999_900_000;
    const lastCheckMs = lastProgressMs + 60_000;
    const renderedBanner = mountStalledNoticeBanner({ checkedAt: lastCheckMs, progressAt: lastProgressMs });

    assert.match(renderedBanner, /Progress updated/);
    const checkIso = new Date(lastCheckMs).toISOString();
    const progressIso = new Date(lastProgressMs).toISOString();
    assert.ok(renderedBanner.includes(`dateTime="${checkIso}"`));
    assert.ok(renderedBanner.includes(`dateTime="${progressIso}"`));
    assert.match(renderedBanner, /<p role="status"[^>]*>Syncing saved progress<\/p>/);
  });
});

describe("StalledNotice Banner - Interactive Control States", () => {
  it("locks reload trigger with disabled and aria-busy attributes while operation is pending", () => {
    const pendingHtml = mountStalledNoticeBanner({ checkedAt: 1_820_000_000_000, progressAt: null }, true);

    assert.match(pendingHtml, /disabled=""/);
    assert.match(pendingHtml, /aria-busy="true"/);
    assert.match(pendingHtml, /Reload results/);
  });
});
