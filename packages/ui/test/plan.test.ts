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
import { PLAN_SYNC_MS, backgroundTasks, bindingRow, contextualPlanAccountId, formatReset, legacyPlanAccounts, mergePlanAccounts, planAccount, planAge, planReadFailed, planSyncDue, planView, startPlanPolling, startPlanSync } from "../src/model/plan.js";
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
    const html = renderToStaticMarkup(createElement(MeterDetails, { view, title: "Work" }));
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
    const html = renderToStaticMarkup(createElement(MeterDetails, { view, title: "Default login" }));
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
    // Work's figure is the limit that binds: its weekly 40% is higher than its 12% window.
    assert.match(nearCapHint({ ...project, defaultAccountId: null }, [accountView], records, NOW) ?? "", /Default login at 91%, Work at 40% weekly/);
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

  it("counts whole minutes under an hour, rounded up, and never shows seconds", () => {
    // The clock ticks once a minute, so a seconds figure would be stale for up to a minute.
    assert.equal(formatReset(12 * 60_000 + 40_000), "13m");
    assert.equal(formatReset(30_000), "<1m");
    assert.equal(formatReset(1), "<1m");
    assert.equal(formatReset(60_000), "1m");
    assert.equal(formatReset(60_001), "2m");
    assert.equal(formatReset(59 * 60_000), "59m");
    assert.equal(formatReset(59 * 60_000 + 30_000), "1h", "rounding up rolls over into the hour instead of printing 60m");
    assert.equal(formatReset(60 * 60_000), "1h");
    assert.doesNotMatch(formatReset(12 * 60_000 + 40_000), /\ds/);
  });

  it("puts the minute countdown into the row text", () => {
    const reading = (ms: number) => planView({ tier: "high", observedAtMs: NOW,
      window: { usedPercent: 10, resetsAtMs: NOW + ms, windowDurationMins: 300 },
      weekly: { usedPercent: 10, resetsAtMs: NOW + 2 * 24 * 60 * 60_000, windowDurationMins: null } }, NOW)?.rows[0]?.resets;
    assert.equal(reading(12 * 60_000 + 40_000), "Resets in 13m");
    assert.equal(reading(30_000), "Resets in <1m");
  });
});

/** Both limits set apart, the way a short window and a weekly cap really differ. */
function limits(window: number, weekly: number, at = NOW): PlanUsage {
  return { ...quota(window, at), weekly: { usedPercent: weekly, resetsAtMs: at + 3 * 24 * 60 * 60_000, windowDurationMins: null } };
}
function windowPassed(reading: PlanUsage): PlanUsage {
  return { ...reading, window: { ...reading.window, resetsAtMs: NOW - 1 } };
}

describe("binding limit", () => {
  it("is the highest current limit, the short window on a tie, and none when nothing is current", () => {
    assert.equal(bindingRow(planView(limits(10, 97), NOW)!)?.key, "weekly");
    assert.equal(bindingRow(planView(limits(80, 40), NOW)!)?.key, "window");
    assert.equal(bindingRow(planView(limits(50, 50), NOW)!)?.key, "window", "a tie goes to the short window");
    assert.equal(bindingRow(planView(windowPassed(limits(10, 97)), NOW)!)?.key, "weekly", "an expired window cannot bind");
    assert.equal(bindingRow(planView(windowPassed(limits(97, 10)), NOW)!)?.key, "weekly", "its old percentage does not outrank a current limit");
    assert.equal(bindingRow(planView(limits(10, 97, NOW - 31 * 60_000), NOW)!), null, "an old reading binds nothing");
    assert.equal(bindingRow(planView(limits(10, 97), NOW, account(null, 10, { status: "unavailable" }))!), null);
  });

  it("drives the sidebar pill: the weekly figure, marked, in its own tone", () => {
    const html = render(PlanPill, { planUsageAccounts: [account(null, 10, { usage: limits(10, 97) })] });
    assert.match(html, /97% wk<\/button>/);
    assert.match(html, /text-danger-text/);
    assert.doesNotMatch(html, /10%<\/button>/);
    assert.match(html, /The pill shows the weekly limit/);
    assert.match(html, /5-hour window: 10% used/);
    assert.match(html, /Weekly limit: 97% used, resets in 3d/);
  });

  it("keeps the window figure, unmarked, when the window binds or ties", () => {
    const window = render(PlanPill, { planUsageAccounts: [account(null, 80, { usage: limits(80, 40) })] });
    assert.match(window, /80%<\/button>/);
    assert.match(window, /text-warn-text/);
    assert.doesNotMatch(window, /wk<|The pill shows the weekly limit/);
    assert.match(render(PlanPill, { planUsageAccounts: [account(null, 50, { usage: limits(50, 50) })] }), /50%<\/button>/);
  });

  it("shows the weekly figure instead of a dash when only the short window has expired", () => {
    const html = render(PlanPill, { planUsageAccounts: [account(null, 10, { usage: windowPassed(limits(10, 97)) })] });
    assert.match(html, /97% wk<\/button>/);
    assert.doesNotMatch(html, /—<\/button>/);
    assert.match(html, /5-hour window: current usage unknown; previous reading 10% used/);
  });

  it("keeps the dash when no limit is current", () => {
    const html = render(PlanPill, { planUsageAccounts: [account(null, 10, { usage: limits(10, 97, NOW - 31 * 60_000) })] });
    assert.match(html, /—<\/button>/);
    assert.doesNotMatch(html, /97%<\/button>|wk</);
  });

  it("is what the new-thread hint compares, so a weekly cap is not missed", () => {
    const high = account(null, 10, { usage: limits(10, 91) });
    const roomy = account("work", 12, { usage: limits(12, 5) });
    const hint = (records: PlanAccountUsage[], now = NOW) => nearCapHint({ ...project, defaultAccountId: null }, [accountView], records, now);
    assert.equal(hint([high, roomy]), "Last reported: Default login at 91% weekly, Work at 12%.");
    assert.match(hint([account(null, 10, { usage: windowPassed(limits(10, 90)) }), roomy]) ?? "", /Default login at 90% weekly/);
    assert.equal(hint([high, roomy], NOW + 31 * 60_000), null, "an old reading still makes no suggestion");
    assert.equal(hint([account(null, 10, { usage: limits(10, 60) }), roomy]), null, "below 80% on every limit there is nothing to suggest");
  });
});

describe("wording by source", () => {
  it("does not promise a refresh for a reading only the Muse runtime reports", () => {
    const runtime = account(null, 92, { usage: quota(92, NOW - 31 * 60_000), source: "runtime", status: "runtime-only", checkedAtMs: null });
    const html = render(PlanMeter, { planUsageAccounts: [runtime] });
    assert.doesNotMatch(html, /refresh needed|until it is refreshed/);
    assert.match(html, /Muse reports this again when it next sends usage\. Refresh cannot update it\./);
    const passed = render(PlanMeter, { planUsageAccounts: [{ ...runtime, usage: windowPassed(quota(92)) }] });
    assert.match(passed, /Reset time passed · waiting for Muse(&#x27;|')s next report/);
    assert.doesNotMatch(passed, /refresh needed|until it is refreshed/);
    assert.match(passed, /Refresh cannot update it/);
  });

  it("keeps the refresh wording where Refresh asks Meta again", () => {
    const html = render(PlanMeter, { planUsageAccounts: [account(null, 92, { usage: windowPassed(quota(92)) })] });
    assert.match(html, /Reset time passed · refresh needed/);
    assert.match(html, /until it is refreshed/);
    assert.doesNotMatch(html, /Refresh cannot update it|waiting for Muse/);
    for (const record of [
      account(null, 92, { usage: quota(92, NOW - 31 * 60_000), status: "unavailable" }),
      // Muse reported newer numbers on an account Ancilla also checks directly: the next check replaces them.
      account(null, 92, { usage: quota(92, NOW - 31 * 60_000), source: "runtime", status: "runtime-only" }),
    ]) {
      const stale = render(PlanMeter, { planUsageAccounts: [record] });
      assert.match(stale, /until it is refreshed/);
      assert.doesNotMatch(stale, /Refresh cannot update it/);
    }
  });

  it("works out whether Refresh can help from what the server knows about the account", () => {
    const usage = quota(10);
    const refreshable = (patch: Partial<PlanAccountUsage>) => planView(usage, NOW, account(null, 10, patch))?.refreshable;
    assert.equal(planView(usage, NOW)?.refreshable, true, "without an account the plain wording stays");
    assert.equal(refreshable({}), true);
    assert.equal(refreshable({ status: "unavailable", checkedAtMs: null, source: "runtime" }), true, "a failed read is retried by Refresh");
    assert.equal(refreshable({ source: "runtime", status: "runtime-only" }), true, "an account with a direct check");
    assert.equal(refreshable({ source: "runtime", status: "runtime-only", checkedAtMs: null }), false);
    assert.equal(refreshable({ source: "saved", status: "runtime-only", checkedAtMs: null }), false);
    assert.equal(refreshable({ source: "meta", status: "runtime-only", checkedAtMs: null }), false, "Meta's numbers, but no check to repeat");
    const passed = planView(windowPassed(usage), NOW, account(null, 10, { source: "runtime", status: "runtime-only", checkedAtMs: null }));
    assert.equal(passed?.rows[0]?.resets, "Reset time passed · waiting for Muse's next report");
    assert.equal(planView(windowPassed(usage), NOW)?.rows[0]?.resets, "Reset time passed · refresh needed");
  });

  it("words a Meta reading whose login lost its token as one that cannot be refreshed, and not as a runtime reading", () => {
    // The server keeps the last Meta reading, with no check time, when there is no token left to check with.
    const lost = account(null, 92, { usage: quota(92, NOW - 31 * 60_000), source: "meta", status: "runtime-only", checkedAtMs: null });
    assert.match(quotaAvailabilityLabel(lost), /^Last reported by Meta\. A current account check is unavailable/);
    const html = render(PlanMeter, { planUsageAccounts: [lost] });
    assert.match(html, /Meta account/);
    assert.doesNotMatch(html, /Muse runtime|until it is refreshed/);
    assert.match(html, /Refresh cannot update it/);
  });

  it("words a report from a server that predates direct checks as a runtime reading, since that server never asked Meta", () => {
    const old = quota(92, NOW - 31 * 60_000);
    const [legacy] = legacyPlanAccounts({ usage: old, byAccount: {}, accountId: null }, []);
    assert.equal(legacy?.checkedAtMs, null);
    const html = render(PlanMeter, { planUsageAccounts: [legacy!] });
    assert.match(html, /Refresh cannot update it/);
    assert.doesNotMatch(html, /until it is refreshed/);
    // A failed read is still worth retrying, wherever the report came from.
    const [failed] = legacyPlanAccounts({ usage: old, byAccount: {}, accountId: null, status: "unavailable" }, []);
    assert.match(render(PlanMeter, { planUsageAccounts: [failed!] }), /until it is refreshed/);
  });
});

describe("reading age label", () => {
  const html = (ms: number) => renderToStaticMarkup(createElement(MeterDetails, { view: planView(quota(10, NOW - ms), NOW)!, title: "Work" }));
  const DAY = 24 * 60 * 60_000;

  it("uses the short age the pill uses, never a calendar date", () => {
    assert.match(html(45_000), /Reported just now/);
    assert.match(html(60 * 60_000), /Reported 1h ago/);
    assert.match(html(28 * 60 * 60_000), /Reported 28h ago/);
    assert.match(html(40 * DAY), /Reported 40d ago/);
    assert.doesNotMatch(html(40 * DAY), /[A-Z][a-z]{2} \d{1,2} ago/);
  });

  it("agrees with planAge, which the pill tooltip reads, at every age", () => {
    for (const ms of [45_000, 4 * 60_000, 60 * 60_000, 28 * 60 * 60_000, 36 * DAY]) {
      const age = planAge(NOW - ms, NOW);
      assert.match(html(ms), age === "just now" ? /Reported just now/ : new RegExp(`Reported ${age} ago`));
    }
  });
});

describe("background plan sync", () => {
  it("is due only while the window is in sight, once the interval has passed", () => {
    assert.equal(PLAN_SYNC_MS, 5 * 60_000);
    assert.equal(planSyncDue("hidden", NOW - 3 * PLAN_SYNC_MS, NOW), false, "never while hidden, however long ago");
    assert.equal(planSyncDue("visible", NOW - PLAN_SYNC_MS + 1, NOW), false);
    assert.equal(planSyncDue("visible", NOW - PLAN_SYNC_MS, NOW), true);
    assert.equal(planSyncDue("visible", NOW - 40 * 60_000, NOW), true, "back in sight after a long idle stretch");
    assert.equal(planSyncDue("visible", NOW + 60_000, NOW), true, "a clock moved back is not waited out");
  });

  it("is due after a minute when the last read failed, and never while hidden", () => {
    assert.equal(planSyncDue("visible", NOW - 60_000, NOW), false);
    assert.equal(planSyncDue("visible", NOW - 60_000, NOW, true), true);
    assert.equal(planSyncDue("visible", NOW - 59_999, NOW, true), false);
    assert.equal(planSyncDue("hidden", NOW - 3 * PLAN_SYNC_MS, NOW, true), false);
  });

  it("calls a read failed when the request failed or Meta could not be asked for an account", () => {
    assert.equal(planReadFailed(app()), false);
    assert.equal(planReadFailed(app({ planUsageStatus: "ready", planUsageAccounts: [account(null, 10), account("work", 20, { status: "runtime-only" })] })), false);
    assert.equal(planReadFailed(app({ planUsageStatus: "unavailable" })), true);
    assert.equal(planReadFailed(app({ planUsageAccounts: [account(null, 10), account("work", 20, { status: "unavailable" })] })), true);
    assert.equal(planReadFailed(app({ planUsageAccounts: [account(null, 10, { status: "login-required", usage: null, source: null })] })), false, "a login that needs signing in is not a failure to retry");
  });
});

/** The page, the clock and the controller a plan upkeep runs against, driven by hand. */
function upkeepRig(patch: Partial<AppState> = {}) {
  let now = NOW;
  let state = app({ boot: "ready", env: { museFound: true } as unknown as AppState["env"], ...patch });
  const timers = new Map<number, { handler: () => void; ms: number }>();
  const listeners = new Set<() => void>();
  const reads: ({ background?: boolean } | undefined)[] = [];
  const page = {
    visibilityState: "visible",
    addEventListener: (_type: "visibilitychange", listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: "visibilitychange", listener: () => void) => { listeners.delete(listener); },
  };
  const controller = {
    store: { get: () => state },
    loadPlanUsage: (options?: { background?: boolean }) => { reads.push(options); return Promise.resolve(); },
  };
  let nextTimer = 1;
  const clock = {
    now: () => now,
    setInterval: (handler: () => void, ms: number) => { timers.set(nextTimer, { handler, ms }); return nextTimer++; },
    clearInterval: (handle: unknown) => { timers.delete(handle as number); },
  };
  return {
    page, controller, clock, reads, timers, listeners,
    /** Time passes, and the timer fires as often as it is due. */
    tick(ms: number) { now += ms; for (const timer of [...timers.values()]) timer.handler(); },
    patch(next: Partial<AppState>) { state = { ...state, ...next }; },
    /** The window goes out of sight or comes back, and says so. */
    show(visibility: "visible" | "hidden") { page.visibilityState = visibility; for (const listener of [...listeners]) listener(); },
  };
}

describe("the sidebar's plan sync", () => {
  const QUIET = { background: true };

  it("reads quietly once the interval has passed, then waits for the next one", () => {
    const rig = upkeepRig();
    const stop = startPlanSync(rig.controller, rig.page, rig.clock);
    assert.deepEqual([...rig.timers.values()].map((timer) => timer.ms), [60_000], "it looks at the clock once a minute");
    assert.equal(rig.listeners.size, 1);
    for (let minute = 1; minute < 5; minute++) rig.tick(60_000);
    assert.deepEqual(rig.reads, [], "nothing before five minutes");
    rig.tick(60_000);
    assert.deepEqual(rig.reads, [QUIET], "a background read, so Refresh does not spin");
    for (let minute = 1; minute < 5; minute++) rig.tick(60_000);
    assert.equal(rig.reads.length, 1, "each read starts the interval again");
    rig.tick(60_000);
    assert.equal(rig.reads.length, 2);
    stop();
    assert.equal(rig.timers.size, 0);
    assert.equal(rig.listeners.size, 0);
  });

  it("does nothing until Muse is set up and the app has booted", () => {
    const rig = upkeepRig({ boot: "loading" });
    startPlanSync(rig.controller, rig.page, rig.clock);
    rig.tick(10 * 60_000);
    rig.patch({ boot: "error" });
    rig.tick(10 * 60_000);
    rig.patch({ boot: "ready", env: null });
    rig.tick(10 * 60_000);
    rig.patch({ env: { museFound: false } as unknown as AppState["env"] });
    rig.tick(10 * 60_000);
    assert.deepEqual(rig.reads, []);
    rig.patch({ env: { museFound: true } as unknown as AppState["env"] });
    rig.tick(60_000);
    assert.deepEqual(rig.reads, [QUIET]);
  });

  it("stays quiet while the window is hidden and reads as soon as it comes back after a long absence", () => {
    const rig = upkeepRig();
    startPlanSync(rig.controller, rig.page, rig.clock);
    rig.show("hidden");
    rig.tick(20 * 60_000);
    assert.deepEqual(rig.reads, []);
    rig.show("visible");
    assert.deepEqual(rig.reads, [QUIET], "no waiting for the next tick");
    rig.show("hidden");
    rig.show("visible");
    assert.equal(rig.reads.length, 1, "coming back at once does not read twice");
  });

  it("tries again after a minute when the last read failed, and goes back to the ordinary interval once it works", () => {
    const rig = upkeepRig({ planUsageStatus: "unavailable" });
    startPlanSync(rig.controller, rig.page, rig.clock);
    rig.tick(60_000);
    assert.deepEqual(rig.reads, [QUIET]);
    rig.patch({ planUsageStatus: "ready", planUsageAccounts: [account(null, 10)] });
    rig.tick(60_000);
    assert.equal(rig.reads.length, 1, "a healthy meter is not read every minute");
    rig.patch({ planUsageAccounts: [account(null, 10, { status: "unavailable" })] });
    rig.tick(60_000);
    assert.equal(rig.reads.length, 2, "a failed check on one account counts too");
  });
});

describe("the Usage page's plan polling", () => {
  const QUIET = { background: true };

  it("reads once at the start with the spinner, then quietly every minute and when the window comes back", () => {
    const rig = upkeepRig();
    const stop = startPlanPolling(rig.controller, rig.page, rig.clock);
    assert.deepEqual(rig.reads, [undefined], "the opening read is the one that shows it is checking");
    assert.deepEqual([...rig.timers.values()].map((timer) => timer.ms), [60_000]);
    rig.tick(60_000);
    assert.deepEqual(rig.reads, [undefined, QUIET]);
    rig.show("hidden");
    rig.tick(60_000);
    assert.equal(rig.reads.length, 2, "never while hidden");
    rig.show("visible");
    assert.deepEqual(rig.reads, [undefined, QUIET, QUIET]);
    stop();
    assert.equal(rig.timers.size, 0);
    assert.equal(rig.listeners.size, 0);
    rig.tick(60_000);
    assert.equal(rig.reads.length, 3, "nothing after the page is gone");
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
