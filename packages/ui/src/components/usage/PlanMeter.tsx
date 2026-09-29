import { GaugeIcon } from "../ui/icons.js";
import { useEffect } from "react";
import { shallowEqual, useApp, useController, useNow } from "../../app/context.js";
import { relativeTime } from "../../model/format.js";
import { contextualPlanAccountId, planAccount, planAccountChoices, planView, type PlanTone, type PlanView } from "../../model/plan.js";
import type { PlanAccountUsage } from "../../types.js";
import { Tip } from "../ui/overlays.js";
import { Button, cn } from "../ui/primitives.js";

const FILL: Record<PlanTone, string> = { ok: "bg-accent", warn: "bg-warn", danger: "bg-danger" };
const TEXT: Record<PlanTone, string> = { ok: "text-muted", warn: "text-warn-text", danger: "text-danger-text" };

/** The reported subscription allowance, separate from local token counts and API-rate estimates. */
export function PlanMeter() {
  const controller = useController();
  const selected = useApp((s) => s.planUsageSelectedAccountId);
  const choices = useApp(planAccountChoices, (a, b) => a.length === b.length && a.every((entry, i) => entry.id === b[i].id && entry.name === b[i].name));
  const accountId = choices.some((choice) => choice.id === selected) ? selected : null;
  const account = useApp((s) => planAccount(s, accountId), shallowEqual);
  const now = useNow(60_000);
  const loading = useApp((s) => s.planUsageLoading);
  useEffect(() => {
    void controller.loadPlanUsage();
    const refresh = () => { if (document.visibilityState === "visible") void controller.loadPlanUsage(); };
    // This checks the account without creating a thread or making a model call.
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [controller]);
  const title = choices.find((choice) => choice.id === accountId)?.name ?? "Default login";
  return (
    <section aria-label="Muse subscription" className="rounded-xl bg-raised px-4 py-3.5 shadow-panel">
      <div className="flex flex-wrap items-center gap-2">
        <GaugeIcon size={15} className="text-subtle" />
        <h2 className="text-sm font-medium text-fg">Muse subscription</h2>
        <span className="flex-1" />
        {choices.length > 1 ? <select aria-label="Subscription account" value={accountId ?? ""}
          className="max-w-full rounded-md border border-line bg-raised px-2 py-1 text-xs text-fg"
          onChange={(event) => controller.selectPlanUsageAccount(event.currentTarget.value || null)}>
          {choices.map((choice) => <option key={choice.id ?? ""} value={choice.id ?? ""}>{choice.name}</option>)}
        </select> : null}
        <Button size="sm" variant="ghost" loading={loading} disabled={loading} onClick={() => void controller.loadPlanUsage()}>
          Refresh
        </Button>
      </div>
      <AccountDetails account={account} title={title} now={now} loading={loading} />
      {account.status === "login-required" ? <Button size="sm" variant="ghost" className="mt-2" onClick={() => controller.navigate({ kind: "settings" })}>Open sign-in settings</Button> : null}
    </section>
  );
}

export function quotaAvailabilityLabel(account: PlanAccountUsage): string {
  switch (account.status) {
    case "unavailable": return account.usage
      ? "Could not refresh this account’s subscription limits. The previous reading is shown for reference; current allowance is unknown."
      : "Could not read this account’s subscription limits. Refresh to retry.";
    case "login-required": return "Sign in to this Muse account to check its subscription limits.";
    case "no-subscription": return "Meta reports no Muse subscription for this login. No subscription allowance is available to display.";
    case "not-reported": return account.checkedAtMs === null
      ? "Subscription limits have not been reported for this account. Refresh to check; missing values are unknown."
      : "Meta did not report subscription limits for this account. Missing values are unknown, not zero usage.";
    case "runtime-only": return !account.usage
      ? "The Muse runtime has not reported subscription limits for this login. Current allowance is unknown."
      : account.source === "saved"
        ? "This is a saved reading. A current account check is unavailable, so the allowance may have changed."
        : "Last reported by the Muse runtime. Activity in other clients may have changed this account’s allowance.";
    case "ready": return account.source === "meta"
      ? "Account-wide limits reported by Meta, including activity outside Ancilla. Refresh checks the account without using model allowance."
      : "Last reported by Muse. Activity in other clients may change this account’s allowance before the next reading.";
  }
}

function AccountDetails(props: { account: PlanAccountUsage; title: string; now: number; loading?: boolean }) {
  const { account, title, now, loading } = props;
  const view = planView(account.usage, now, account);
  return <>
    {view ? <MeterDetails view={view} title={title} now={now} account={account} /> : <>
      <div className="mt-2 flex flex-wrap items-baseline gap-2 text-xs">
        <h3 className="font-medium text-muted">{title}</h3>
        {account.planName ? <span className="text-subtle">{account.planName}</span> : null}
      </div>
      <MissingQuota loading={loading} status={account.status} />
    </>}
    <p className={cn("mt-3 text-xs leading-5 text-pretty", account.status === "unavailable" ? "text-warn-text" : "text-subtle")}>
      {quotaAvailabilityLabel(account)}
    </p>
  </>;
}

/** No empty progress bars: an absent reading must never look like unused allowance. */
function MissingQuota(props: { loading?: boolean; status: PlanAccountUsage["status"] }) {
  const message = props.loading ? "Checking subscription…" : props.status === "no-subscription" ? "No subscription" : props.status === "login-required" ? "Sign-in needed" : "Not reported";
  return (
    <div className="mt-3 grid gap-3 @min-[520px]:grid-cols-2">
      {["Usage window", "Weekly limit"].map((label) => (
        <div key={label} className="rounded-lg border border-line px-3 py-2.5">
          <p className="text-xs text-muted">{label}</p>
          <p className="mt-1 text-sm text-subtle">{message}</p>
        </div>
      ))}
    </div>
  );
}

/** Pure quota view, retaining past readings without presenting them as the current allowance. */
export function MeterDetails(props: { view: PlanView; title: string; now: number; saved?: boolean; account?: PlanAccountUsage }) {
  const { view, title, now, account } = props;
  const saved = props.saved || account?.source === "saved";
  const planName = account?.planName ?? view.tier;
  const source = saved ? "Saved reading" : account?.source === "meta" ? "Meta account" : "Muse runtime";
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <h3 className="font-medium text-muted">{title}</h3>
        {planName ? <span className="rounded-md bg-active px-1.5 py-px text-2xs text-muted">{planName}</span> : null}
        <span className="flex-1" />
        <time dateTime={new Date(view.observedAtMs).toISOString()} title={new Date(view.observedAtMs).toLocaleString()} className={cn("text-2xs", view.stale || saved ? "text-warn-text" : "text-subtle")}>
          {source} · {updatedLabel(view, now)}
        </time>
      </div>
      <div className="mt-3 grid gap-3 @min-[520px]:grid-cols-2">
        {view.rows.map((row) => {
          const current = row.current && !saved;
          return <div key={row.key} className="min-w-0 rounded-lg border border-line px-3 py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
              <span className="text-muted">{row.label}</span>
              <span className="flex-1" />
              <span className={cn("font-medium tabular-nums", current ? TEXT[row.tone] : "text-subtle")}>{current ? `${row.percent}% used` : "Current usage unknown"}</span>
            </div>
            {current ? <div role="progressbar" aria-label={`${row.label} used`} aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={row.barPercent} aria-valuetext={`${row.percent}% used as last reported by ${account?.source === "meta" ? "Meta" : "Muse"}`}
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-active">
              <div className={cn("h-full rounded-full transition-[width] duration-300 ease-out", FILL[row.tone])} style={{ width: `${row.barPercent}%` }} />
            </div> : <p className="mt-2 text-2xs text-subtle tabular-nums">Previous reading: {row.percent}% used</p>}
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-2xs tabular-nums">
              <span className={cn(row.expired ? "text-warn-text" : "text-subtle")}>{row.resets}</span>
              {current ? <span className="text-muted">{row.remainingPercent}% remaining at reading</span> : null}
            </div>
            <time dateTime={new Date(row.resetsAtMs).toISOString()} className="mt-1 block text-2xs text-subtle tabular-nums">
              {new Date(row.resetsAtMs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
            </time>
          </div>;
        })}
      </div>
      {view.stale ? <p className="mt-2 text-2xs text-warn-text">A reading is out of date. Current allowance is unknown for that window until it is refreshed.</p> : null}
    </div>
  );
}

/** The default login remains visible when a named account is selected. */
export function AccountMeters() {
  const mainAccount = useApp((s) => s.planUsageSelectedAccountId);
  const readings = useApp((s) => planAccountChoices(s).map((choice) => ({ ...choice, account: planAccount(s, choice.id) })),
    (a, b) => a.length === b.length && a.every((entry, i) => entry.id === b[i].id && entry.name === b[i].name && shallowEqual(entry.account, b[i].account)));
  const selected = readings.some((entry) => entry.id === mainAccount) ? mainAccount : null;
  const others = readings.filter((entry) => entry.id !== selected);
  const now = useNow(60_000, others.length > 0);
  if (others.length === 0) return null;
  return (
    <div className="mb-6 grid gap-3">
      {others.map(({ id, name, account }) => <section key={id ?? ""} aria-label={`${name} subscription`} className="rounded-xl bg-raised px-4 py-3.5 shadow-panel">
        <AccountDetails account={account} title={name} now={now} />
      </section>)}
    </div>
  );
}

function updatedLabel(view: PlanView, now: number): string {
  const age = relativeTime(new Date(view.observedAtMs).toISOString(), now);
  return age === "now" ? "Reported just now" : `Reported ${age} ago`;
}

/** The current thread/project's account, with an unknown marker instead of an old percentage. */
export function PlanPill() {
  const controller = useController();
  const accountId = useApp(contextualPlanAccountId);
  const account = useApp((s) => planAccount(s, accountId), shallowEqual);
  const name = useApp((s) => accountId === null ? "Default login" : s.accounts?.find((entry) => entry.id === accountId)?.name ?? accountId);
  const now = useNow(60_000, account.usage !== null);
  const view = planView(account.usage, now, account);
  const first = view?.rows[0];
  if (!view || !first) return null;
  const label = `${name}. ` + view.rows.map((row) => row.current
    ? `${row.label}: ${row.percent}% used, ${row.resets.toLowerCase()}`
    : `${row.label}: current usage unknown; previous reading ${row.percent}% used`).join(". ");
  return (
    <Tip label={`${label}. ${view.age === "just now" ? "Reported just now" : `Reported ${view.age} ago`}.`} side="top">
      <button type="button" aria-label={`Plan usage. ${label}`} onClick={() => controller.navigate({ kind: "usage" })}
        className={cn("inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-2xs font-medium tabular-nums transition-colors duration-100 hover:bg-hover", first.current ? TEXT[first.tone] : "text-subtle")}>
        <GaugeIcon size={12} />{first.current ? `${first.percent}%` : "—"}
      </button>
    </Tip>
  );
}
