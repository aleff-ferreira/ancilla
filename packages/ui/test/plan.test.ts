import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MeterDetails } from "../src/components/usage/PlanMeter.js";
import { emptyFold, type ThreadFold } from "../src/model/fold.js";
import { backgroundTasks, formatReset, planAge, planView } from "../src/model/plan.js";
import type { MspItem } from "../src/types.js";

const NOW = 1_800_000_000_000;

describe("plan meter", () => {
  it("shows nothing until Muse has seen a window", () => {
    assert.equal(planView(null, NOW), null);
  });

  it("names the short window by its length and counts down to each reset", () => {
    const view = planView(
      {
        tier: "high_usage",
        observedAtMs: NOW - 60_000,
        window: { usedPercent: 72.4, resetsAtMs: NOW + (2 * 60 + 14) * 60_000, windowDurationMins: 300 },
        weekly: { usedPercent: 94, resetsAtMs: NOW - 1, windowDurationMins: null },
      },
      NOW,
    );
    assert.equal(view?.tier, "High usage");
    assert.deepEqual(view?.rows, [
      { key: "window", label: "5-hour window", percent: 72, barPercent: 72, remainingPercent: 28, tone: "warn", resetsAtMs: NOW + (2 * 60 + 14) * 60_000, expired: false, resets: "Resets in 2h 14m" },
      { key: "weekly", label: "Weekly limit", percent: 94, barPercent: 94, remainingPercent: 6, tone: "danger", resetsAtMs: NOW - 1, expired: true, resets: "Reset time passed · awaiting Muse" },
    ]);
    assert.equal(view?.stale, true, "a passed reset makes this observation stale");
  });

  it("carries how old the reading is, from the first minute", () => {
    // Muse only reports this with a model call, so a percentage on its own says nothing about now.
    const at = (ms: number) =>
      planView(
        {
          tier: "high_usage",
          observedAtMs: NOW - ms,
          window: { usedPercent: 0, resetsAtMs: NOW + 60_000, windowDurationMins: 300 },
          weekly: { usedPercent: 1, resetsAtMs: NOW + 60_000, windowDurationMins: null },
        },
        NOW,
      )?.age;
    assert.equal(at(5_000), "just now");
    assert.equal(at(4 * 60_000), "4m");
    assert.equal(at(3 * 60 * 60_000), "3h");
    assert.equal(at(3 * 24 * 60 * 60_000), "3d");
    assert.equal(planAge(NOW, NOW), "just now");
  });

  it("preserves over-quota percentages, caps the bar and marks an old reading as stale", () => {
    const view = planView(
      {
        tier: "everyday",
        observedAtMs: NOW - 2 * 60 * 60_000,
        window: { usedPercent: 140, resetsAtMs: NOW + 1_000, windowDurationMins: 90 },
        weekly: { usedPercent: -3, resetsAtMs: NOW + 1_000, windowDurationMins: null },
      },
      NOW,
    );
    assert.equal(view?.rows[0]?.label, "90-minute window");
    assert.equal(view?.rows[0]?.percent, 140);
    assert.equal(view?.rows[0]?.barPercent, 100);
    assert.equal(view?.rows[0]?.remainingPercent, 0);
    assert.equal(view?.rows[1]?.percent, 0);
    assert.equal(view?.rows[1]?.tone, "ok");
    assert.equal(view?.stale, true);
  });


  it("rejects invalid readings and does not infer a five-hour duration", () => {
    const usage = {
      tier: "everyday", observedAtMs: NOW,
      window: { usedPercent: 25, resetsAtMs: NOW + 60_000, windowDurationMins: null },
      weekly: { usedPercent: 30, resetsAtMs: NOW + 60_000, windowDurationMins: null },
    };
    assert.equal(planView(usage, NOW)?.rows[0]?.label, "Current window");
    assert.equal(planView({ ...usage, observedAtMs: NaN }, NOW), null);
    assert.equal(planView({ ...usage, window: { ...usage.window, usedPercent: Infinity } }, NOW), null);
  });

  it("leaves out a tier that is an opaque id rather than a plan name", () => {
    const reading = (tier: string) =>
      planView(
        {
          tier,
          observedAtMs: NOW,
          window: { usedPercent: 0, resetsAtMs: NOW + 1, windowDurationMins: 300 },
          weekly: { usedPercent: 0, resetsAtMs: NOW + 1, windowDurationMins: null },
        },
        NOW,
      )?.tier;
    // What Muse Code 1.3.0 actually reports.
    assert.equal(reading("27681527378179523"), null);
    assert.equal(reading("power_usage"), "Power usage");
  });
});

describe("subscription quota presentation", () => {
  it("shows reported percentages, bounded accessible bars, reset stamps and saved-reading provenance", () => {
    const view = planView({ tier: "high_usage", observedAtMs: NOW - 60_000,
      window: { usedPercent: 125, resetsAtMs: NOW + 60_000, windowDurationMins: 300 },
      weekly: { usedPercent: 40, resetsAtMs: NOW + 120_000, windowDurationMins: null } }, NOW)!;
    const html = renderToStaticMarkup(createElement(MeterDetails, { view, title: "Work", now: NOW, saved: true }));
    assert.match(html, /5-hour window/);
    assert.match(html, /Weekly limit/);
    assert.match(html, /125% used/);
    assert.match(html, /aria-valuenow="100"/);
    assert.match(html, /aria-valuetext="125% used as last reported by Muse"/);
    assert.match(html, /0% remaining at reading/);
    assert.match(html, /60% remaining at reading/);
    assert.match(html, /Saved reading/);
    assert.match(html, /dateTime=/);
  });

  it("does not imply replenished allowance when a reset stamp passes", () => {
    const view = planView({ tier: "high", observedAtMs: NOW - 60_000,
      window: { usedPercent: 92, resetsAtMs: NOW - 1, windowDurationMins: 300 },
      weekly: { usedPercent: 40, resetsAtMs: NOW - 1, windowDurationMins: null } }, NOW)!;
    const html = renderToStaticMarkup(createElement(MeterDetails, { view, title: "Default login", now: NOW }));
    assert.match(html, /92% used/);
    assert.match(html, /Reset time passed/);
    assert.match(html, /Current allowance is unknown/);
    assert.doesNotMatch(html, /remaining at reading/);
  });
});

describe("reset countdown", () => {
  it("stays in hours for a day or so and switches to days for the weekly cap", () => {
    const hour = 60 * 60 * 1000;
    assert.equal(formatReset(2 * hour + 17 * 60_000), "2h 17m");
    assert.equal(formatReset(47 * hour), "47h");
    assert.equal(formatReset(77 * hour), "3d 5h");
    assert.equal(formatReset(72 * hour), "3d");
  });
});

describe("background tasks", () => {
  it("lists only tool calls still running in the background", () => {
    const item = (itemId: string, patch: Partial<MspItem>): MspItem => ({ itemId, kind: "toolCall", status: "inProgress", revision: 1, ...patch });
    const base = emptyFold();
    const fold: ThreadFold = {
      ...base,
      order: ["a", "b", "c", "d"],
      items: {
        a: item("a", { background: true }),
        b: item("b", { background: false }),
        c: item("c", { background: true, status: "completed" }),
        d: item("d", { kind: "subagent", background: true }),
      },
    };
    assert.deepEqual(backgroundTasks(fold), ["a"]);
  });
});
