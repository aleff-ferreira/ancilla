import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountMeters, MeterDetails, PlanMeter, PlanPill, quotaAvailabilityLabel } from "../src/components/usage/PlanMeter.js";
import { ControllerProvider } from "../src/app/context.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import { nearCapHint } from "../src/components/home/Home.js";
import type { AncillaController } from "../src/model/controller.js";
import { emptyFold, type ThreadFold } from "../src/model/fold.js";
import { backgroundTasks, contextualPlanAccountId, formatReset, legacyPlanAccounts, mergePlanAccounts, planAccount, planAge, planView } from "../src/model/plan.js";
import { defaultPrefs, initialState, Store, type AppState } from "../src/model/store.js";
import type { MspItem, PlanAccountUsage, PlanUsage, ProjectView } from "../src/types.js";
import { session } from "./crew-fixtures.js";

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
      { key: "window", label: "5-hour window", percent: 72, barPercent: 72, remainingPercent: 28, tone: "warn", resetsAtMs: NOW + (2 * 60 + 14) * 60_000, expired: false, current: true, resets: "Resets in 2h 14m" },
      { key: "weekly", label: "Weekly limit", percent: 94, barPercent: 94, remainingPercent: 6, tone: "danger", resetsAtMs: NOW - 1, expired: true, current: false, resets: "Reset time passed · refresh needed" },
    ]);
    assert.equal(view?.stale, true, "a passed reset makes this observation stale");
  });

  it("carries how old the reading is, from the first minute", () => {
    // Account checks and runtime observations both need their actual observation age.
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
        weekly: { usedPercent: 3, resetsAtMs: NOW + 1_000, windowDurationMins: null },
      },
      NOW,
    );
    assert.equal(view?.rows[0]?.label, "90-minute window");
    assert.equal(view?.rows[0]?.percent, 140);
    assert.equal(view?.rows[0]?.barPercent, 100);
    assert.equal(view?.rows[0]?.remainingPercent, 0);
    assert.equal(view?.rows[1]?.percent, 3);
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
    assert.equal(planView({ ...usage, window: { ...usage.window, usedPercent: -3 } }, NOW), null, "invalid negative usage must not be invented as zero");
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
  it("shows reported percentages, bounded accessible bars and reset stamps", () => {
    const view = planView({ tier: "high_usage", observedAtMs: NOW - 60_000,
      window: { usedPercent: 125, resetsAtMs: NOW + 60_000, windowDurationMins: 300 },
      weekly: { usedPercent: 40, resetsAtMs: NOW + 120_000, windowDurationMins: null } }, NOW)!;
    const html = renderToStaticMarkup(createElement(MeterDetails, { view, title: "Work", now: NOW }));
    assert.match(html, /5-hour window/);
    assert.match(html, /Weekly limit/);
    assert.match(html, /125% used/);
    assert.match(html, /aria-valuenow="100"/);
    assert.match(html, /aria-valuetext="125% used as last reported by Muse"/);
    assert.match(html, /0% remaining at reading/);
    assert.match(html, /60% remaining at reading/);
    assert.match(html, /Muse runtime/);
    assert.match(html, /dateTime=/);
  });

  it("does not imply replenished allowance when a reset stamp passes", () => {
    const view = planView({ tier: "high", observedAtMs: NOW - 60_000,
      window: { usedPercent: 92, resetsAtMs: NOW - 1, windowDurationMins: 300 },
      weekly: { usedPercent: 40, resetsAtMs: NOW - 1, windowDurationMins: null } }, NOW)!;
    const html = renderToStaticMarkup(createElement(MeterDetails, { view, title: "Default login", now: NOW }));
    assert.match(html, /92% used/);
    assert.match(html, /Previous reading: 92% used/);
    assert.match(html, /Reset time passed/);
    assert.match(html, /Current allowance is unknown/);
    assert.doesNotMatch(html, /remaining at reading/);
    assert.doesNotMatch(html, /role="progressbar"/);
  });
});

const accountView = { id: "work", name: "Work", hasLogin: true, email: "work@example.test", lastUsedAt: null };
const project: ProjectView = { cwd: "/work", displayName: "work", pinned: false, activityAt: "2026-09-28T00:00:00Z", defaultAccountId: "work", folders: [{ cwd: "/work", displayName: "work" }] };
function quota(percent: number, at = NOW): PlanUsage {
  return { tier: "1234567", observedAtMs: at,
    window: { usedPercent: percent, resetsAtMs: at + 300 * 60_000, windowDurationMins: 300 },
    weekly: { usedPercent: 40, resetsAtMs: at + 7 * 24 * 60 * 60_000, windowDurationMins: null } };
}
function account(accountId: string | null, percent: number, patch: Partial<PlanAccountUsage> = {}): PlanAccountUsage {
  return { accountId, usage: quota(percent), planName: "Muse Plus", source: "meta", status: "ready", checkedAtMs: NOW, ...patch };
}
function app(patch: Partial<AppState> = {}): AppState {
  return { ...initialState(defaultPrefs()), ...patch };
}
function render(Component: ComponentType, patch: Partial<AppState>): string {
  const controller = { store: new Store(app(patch)) } as AncillaController;
  const previous = Date.now;
  Date.now = () => NOW;
  try {
    return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: createElement(Component) }) }));
  } finally { Date.now = previous; }
}

describe("subscription account accuracy", () => {
  it("retains the default login when the newest report belongs to a named account", () => {
    const state = app({ accounts: [accountView], planUsage: quota(87, NOW + 10), planUsageAccountId: "work",
      planUsageAccounts: [account(null, 15), account("work", 87)] });
    assert.equal(planAccount(state, null).usage?.window.usedPercent, 15);
    assert.equal(planAccount(state, "work").usage?.window.usedPercent, 87);
    assert.match(render(PlanMeter, state), /15% used/);
    assert.doesNotMatch(render(PlanMeter, state), /87% used/);
    assert.match(render(PlanMeter, state), /Subscription account/);
    assert.match(render(PlanMeter, state), /Muse Plus/);
  });

  it("keeps the default login visible among other accounts when Work is selected", () => {
    const html = render(AccountMeters, { accounts: [accountView], planUsageSelectedAccountId: "work",
      planUsageAccounts: [account(null, 15), account("work", 87)] });
    assert.match(html, /Default login subscription/);
    assert.match(html, /15% used/);
    assert.doesNotMatch(html, /Work subscription/);
  });

  it("uses the current thread or project account in the sidebar", () => {
    const state = app({ projects: [project], sessions: { s1: session("s1", "Work thread", { accountId: "work" }) },
      accounts: [accountView], planUsageAccounts: [account(null, 15), account("work", 87)] });
    assert.equal(contextualPlanAccountId({ ...state, route: { kind: "thread", sessionId: "s1" } }), "work");
    assert.equal(contextualPlanAccountId({ ...state, route: { kind: "new", cwd: "/work" } }), "work");
    assert.equal(contextualPlanAccountId({ ...state, route: { kind: "usage" }, planUsageSelectedAccountId: null }), null);
    const html = render(PlanPill, { ...state, route: { kind: "thread", sessionId: "s1" } });
    assert.match(html, /Plan usage\. Work\./);
    assert.match(html, /87%<\/button>/);
    assert.doesNotMatch(html, /15%/);
  });

  it("never assigns a legacy named account reading to the default login", () => {
    const reading = quota(75);
    const legacy = legacyPlanAccounts({ usage: reading, byAccount: { work: reading }, accountId: "work", status: "ready" }, []);
    assert.equal(legacy.find((entry) => entry.accountId === null)?.usage, null);
    assert.equal(legacy.find((entry) => entry.accountId === "work")?.usage, reading);
    const retained = legacyPlanAccounts({ usage: reading, byAccount: { work: reading }, accountId: "work" }, [account(null, 11)]);
    assert.equal(retained.find((entry) => entry.accountId === null)?.usage?.window.usedPercent, 11);
  });

  it("shows missing limits, missing subscription and sign-in requirements distinctly without invented zeroes", () => {
    for (const [status, text] of [["not-reported", "did not report subscription limits"], ["no-subscription", "no Muse subscription"], ["login-required", "Sign in to this Muse account"]] as const) {
      const html = render(PlanMeter, { planUsageAccounts: [account(null, 0, { usage: null, source: null, status })] });
      assert.match(html, new RegExp(text));
      assert.doesNotMatch(html, /0%|progressbar/);
    }
  });

  it("renders stale, saved, failed and omitted readings as historical values without current meters", () => {
    for (const record of [
      account(null, 92, { usage: quota(92, NOW - 31 * 60_000) }),
      account(null, 92, { source: "saved", status: "runtime-only" }),
      account(null, 92, { status: "unavailable" }),
      account(null, 92, { status: "not-reported" }),
    ]) {
      const html = render(PlanMeter, { planUsageAccounts: [record] });
      assert.match(html, /Current usage unknown/);
      assert.match(html, /Previous reading: 92% used/);
      assert.doesNotMatch(html, /role="progressbar"|remaining at reading/);
      const pill = render(PlanPill, { planUsageAccounts: [record] });
      assert.match(pill, /—<\/button>/);
      assert.doesNotMatch(pill, /92%<\/button>/);
    }
  });

  it("keeps a valid weekly reading when only the short window has expired", () => {
    const reading = quota(92);
    reading.window.resetsAtMs = NOW - 1;
    const record = account(null, 92, { usage: reading });
    const html = render(PlanMeter, { planUsageAccounts: [record] });
    assert.match(html, /Previous reading: 92% used/);
    assert.equal((html.match(/role="progressbar"/g) ?? []).length, 1);
    assert.match(html, /40% used as last reported by Meta/);
  });

  it("makes near-cap suggestions only from fresh readings for the actual account identities", () => {
    const records = [account(null, 91), account("work", 12)];
    assert.equal(nearCapHint(project, [accountView], records, NOW), null);
    assert.match(nearCapHint({ ...project, defaultAccountId: null }, [accountView], records, NOW) ?? "", /Default login at 91%, Work at 12%/);
    assert.equal(nearCapHint({ ...project, defaultAccountId: null }, [accountView], [{ ...records[0], status: "unavailable" }, records[1]], NOW), null);
    assert.equal(nearCapHint({ ...project, defaultAccountId: null }, [accountView], records, NOW + 31 * 60_000), null);
  });

  it("describes authoritative and runtime sources accurately", () => {
    assert.match(quotaAvailabilityLabel(account(null, 0)), /reported by Meta/);
    assert.match(quotaAvailabilityLabel(account(null, 0, { source: "runtime", status: "runtime-only" })), /Muse runtime/);
    assert.match(quotaAvailabilityLabel(account(null, 0, { source: null, usage: null, status: "runtime-only" })), /has not reported/);
  });
});

describe("subscription report races", () => {
  it("adopts direct account metadata when the same observation arrived as an event first", () => {
    const reported = account(null, 15);
    const event = { ...reported, planName: null, source: "runtime", status: "runtime-only", checkedAtMs: null } as PlanAccountUsage;
    assert.deepEqual(mergePlanAccounts([event], [], [reported]), [reported]);
  });

  it("keeps an intervening runtime correction when an equal-time Meta response has different values", () => {
    const before = account(null, 10, { usage: quota(10, NOW - 100), checkedAtMs: NOW - 100 });
    const reported = account(null, 15);
    const event = account(null, 30, { source: "runtime", status: "runtime-only", checkedAtMs: NOW - 100 });
    assert.deepEqual(mergePlanAccounts([event], [before], [reported]), [event]);
  });

  it("preserves a later runtime observation and its unchanged direct-check time", () => {
    const before = account(null, 15, { checkedAtMs: NOW - 100 });
    const event = { ...before, usage: quota(30, NOW + 50), source: "runtime", status: "runtime-only" } as PlanAccountUsage;
    assert.deepEqual(mergePlanAccounts([event], [before], [account(null, 20)]), [event]);
    assert.equal(event.checkedAtMs, NOW - 100);
  });

  it("allows a newer account check to invalidate a prior reading", () => {
    const before = account(null, 15);
    const report = account(null, 15, { checkedAtMs: NOW + 500, status: "not-reported" });
    assert.deepEqual(mergePlanAccounts([before], [before], [report]), [report]);
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
