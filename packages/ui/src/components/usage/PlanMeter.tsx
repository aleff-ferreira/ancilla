import { GaugeIcon } from "../ui/icons.js";
import { useEffect, useMemo } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import { relativeTime } from "../../model/format.js";
import { planView, type PlanTone, type PlanView } from "../../model/plan.js";
import type { PlanUsageStatus } from "../../types.js";
import { Tip } from "../ui/overlays.js";
import { Button, cn } from "../ui/primitives.js";

const FILL: Record<PlanTone, string> = { ok: "bg-accent", warn: "bg-warn", danger: "bg-danger" };
const TEXT: Record<PlanTone, string> = { ok: "text-muted", warn: "text-warn-text", danger: "text-danger-text" };

function usePlan(): PlanView | null {
  const usage = useApp((s) => s.planUsage);
  const now = useNow(60_000, usage !== null);
  return useMemo(() => planView(usage, now), [usage, now]);
}

/** The reported subscription allowance, separate from local token counts and API-rate estimates. */
export function PlanMeter() {
  const controller = useController();
  const view = usePlan();
  const now = useNow(60_000, view !== null);
  const accounts = useApp((s) => s.accounts);
  const accountId = useApp((s) => s.planUsageAccountId);
  const saved = useApp((s) => s.planUsageSaved);
  const status = useApp((s) => s.planUsageStatus);
  const loading = useApp((s) => s.planUsageLoading);
  useEffect(() => {
    void controller.loadPlanUsage();
    const refresh = () => { if (document.visibilityState === "visible") void controller.loadPlanUsage(); };
    // Reads existing hosts only; this does not create a thread or spend allowance.
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [controller]);
  const source = accountId ? accounts?.find((account) => account.id === accountId)?.name ?? accountId : "Default login";
  return (
    <section aria-label="Muse subscription" className="rounded-xl bg-raised px-4 py-3.5 shadow-panel">
      <div className="flex flex-wrap items-center gap-2">
        <GaugeIcon size={15} className="text-subtle" />
        <h2 className="text-sm font-medium text-fg">Muse subscription</h2>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" loading={loading} disabled={loading} onClick={() => void controller.loadPlanUsage()}>
          Refresh
        </Button>
      </div>
      {view ? <MeterDetails view={view} title={source} now={now} saved={saved} /> : <MissingQuota loading={loading} />}
      <p className={cn("mt-3 text-xs leading-5 text-pretty", status === "unavailable" ? "text-warn-text" : "text-subtle")}>
        {availabilityLabel(status, view !== null)}
      </p>
    </section>
  );
}

function availabilityLabel(status: PlanUsageStatus, hasReading: boolean): string {
  if (status === "unavailable") return hasReading
    ? "Could not refresh Muse quota data. The last reported reading is shown above."
    : "Muse quota data is unavailable. Refresh to retry; an older Muse runtime may not support subscription metrics.";
  if (status === "no-host") return hasReading
    ? "No Muse runtime is active. This saved reading may have changed since it was reported."
    : "No Muse runtime is active yet. Quotas appear after Muse reports them while you work in a thread.";
  return "Muse reports these account-wide limits when its runtime receives an update. Activity in other clients may change your allowance before the next reading. Pay-as-you-go accounts may not report subscription quotas.";
}

/** No empty progress bars: an absent reading must never look like an unused allowance. */
function MissingQuota(props: { loading?: boolean }) {
  return (
    <div className="mt-3 grid gap-3 @min-[520px]:grid-cols-2">
      {["5-hour window", "Weekly limit"].map((label) => (
        <div key={label} className="rounded-lg border border-line px-3 py-2.5">
          <p className="text-xs text-muted">{label}</p>
          <p className="mt-1 text-sm text-subtle">{props.loading ? "Reading Muse quota…" : "Not reported"}</p>
        </div>
      ))}
    </div>
  );
}

/** Pure reported-quota view, also used for account-specific readings. */
export function MeterDetails(props: { view: PlanView; title: string; now: number; saved?: boolean }) {
  const { view, title, now, saved } = props;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <h3 className="font-medium text-muted">{title}</h3>
        {view.tier ? <span className="rounded-md bg-active px-1.5 py-px text-2xs text-muted">{view.tier}</span> : null}
        <span className="flex-1" />
        <time dateTime={new Date(view.observedAtMs).toISOString()} title={new Date(view.observedAtMs).toLocaleString()} className={cn("text-2xs", view.stale || saved ? "text-warn-text" : "text-subtle")}>
          {saved ? "Saved reading · " : ""}{updatedLabel(view, now)}
        </time>
      </div>
      <div className="mt-3 grid gap-3 @min-[520px]:grid-cols-2">
        {view.rows.map((row) => (
          <div key={row.key} className="min-w-0 rounded-lg border border-line px-3 py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
              <span className="text-muted">{row.label}</span>
              <span className="flex-1" />
              <span className={cn("font-medium tabular-nums", TEXT[row.tone])}>{row.percent}% used</span>
            </div>
            <div role="progressbar" aria-label={`${row.label} used`} aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={row.barPercent} aria-valuetext={`${row.percent}% used as last reported by Muse`}
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-active">
              <div className={cn("h-full rounded-full transition-[width] duration-300 ease-out", FILL[row.tone])} style={{ width: `${row.barPercent}%` }} />
            </div>
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-2xs tabular-nums">
              <span className={cn(row.expired ? "text-warn-text" : "text-subtle")}>{row.resets}</span>
              {!row.expired ? <span className="text-muted">{row.remainingPercent}% remaining at reading</span> : null}
            </div>
            <time dateTime={new Date(row.resetsAtMs).toISOString()} className="mt-1 block text-2xs text-subtle tabular-nums">
              {new Date(row.resetsAtMs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
            </time>
          </div>
        ))}
      </div>
      {view.stale ? <p className="mt-2 text-2xs text-warn-text">This reading is out of date. Current allowance is unknown until Muse reports again.</p> : null}
    </div>
  );
}

/** Named accounts without quota telemetry remain visible as unreported, rather than silently disappearing. */
export function AccountMeters() {
  const accounts = useApp((s) => s.accounts);
  const byAccount = useApp((s) => s.planUsageByAccount);
  const mainAccount = useApp((s) => s.planUsageAccountId);
  const savedAccounts = useApp((s) => s.planUsageSavedAccounts);
  const now = useNow(60_000, (accounts?.length ?? 0) > 0);
  const others = (accounts ?? []).filter((account) => account.id !== mainAccount);
  if (others.length === 0) return null;
  return (
    <div className="mb-6 grid gap-3">
      {others.map((account) => {
        const view = planView(byAccount[account.id] ?? null, now);
        return (
          <section key={account.id} aria-label={`${account.name} subscription`} className="rounded-xl bg-raised px-4 py-3.5 shadow-panel">
            {view ? <MeterDetails view={view} title={account.name} now={now} saved={savedAccounts.includes(account.id)} /> : <>
              <h3 className="text-sm font-medium text-muted">{account.name}</h3>
              <p className="mt-1 text-xs text-subtle">{account.hasLogin ? "No subscription quota has been reported for this account." : "Sign in to this account to receive subscription quota readings."}</p>
            </>}
          </section>
        );
      })}
    </div>
  );
}

function updatedLabel(view: PlanView, now: number): string {
  const age = relativeTime(new Date(view.observedAtMs).toISOString(), now);
  return age === "now" ? "Reported just now" : `Reported ${age} ago`;
}

/** The rolling window's percentage, small enough for the sidebar footer; it opens the usage page. */
export function PlanPill() {
  const controller = useController();
  const view = usePlan();
  const saved = useApp((s) => s.planUsageSaved);
  const first = view?.rows[0];
  if (!view || !first) return null;
  const prefix = view.stale ? "Outdated reading. " : saved ? "Saved reading. " : "";
  const label = prefix + view.rows.map((row) => `${row.label}: ${row.percent}% used, ${row.resets.toLowerCase()}`).join(". ");
  return (
    <Tip label={`${label}. ${view.age === "just now" ? "Reported just now" : `Reported ${view.age} ago`}.`} side="top">
      <button type="button" aria-label={`Plan usage. ${label}`} onClick={() => controller.navigate({ kind: "usage" })}
        className={cn("inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-2xs font-medium tabular-nums transition-colors duration-100 hover:bg-hover", TEXT[first.tone])}>
        <GaugeIcon size={12} />{first.percent}%
      </button>
    </Tip>
  );
}
