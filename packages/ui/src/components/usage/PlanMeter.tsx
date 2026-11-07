import { GaugeIcon } from "../ui/icons.js";
import { useEffect } from "react";
import { shallowEqual, useApp, useController, useNow } from "../../app/context.js";
import { bindingRow, contextualPlanAccountId, lastKnownRow, planAccount, planAccountChoices, planView, startPlanPolling, type PlanRow, type PlanTone, type PlanView } from "../../model/plan.js";
import type { PlanAccountUsage } from "../../types.js";
import { Tip } from "../ui/overlays.js";
import { Button, cn } from "../ui/primitives.js";

const FILL: Record<PlanTone, string> = { ok: "bg-accent", warn: "bg-warn", danger: "bg-danger" };
const TEXT: Record<PlanTone, string> = { ok: "text-muted", warn: "text-warn-text", danger: "text-danger-text" };

/** Meta's own usage page, which Meta documents as the Usage dashboard and which shows the current figures at any time. */
export const META_USAGE_URL = "https://dev.meta.ai/usage";

function MetaUsageLink() {
  return <a href={META_USAGE_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-fg">Meta&apos;s usage page</a>;
}

/** The reported subscription allowance, separate from local token counts and API-rate estimates. */
export function PlanMeter() {
  const controller = useController();
  const selected = useApp((s) => s.planUsageSelectedAccountId);
  const choices = useApp(planAccountChoices, (a, b) => a.length === b.length && a.every((entry, i) => entry.id === b[i].id && entry.name === b[i].name));
  const accountId = choices.some((choice) => choice.id === selected) ? selected : null;
  const account = useApp((s) => planAccount(s, accountId), shallowEqual);
  const now = useNow(60_000);
  const loading = useApp((s) => s.planUsageLoading);
  // The first read shows the Refresh spinner and "Checking subscription…"; the quiet ones after it leave them alone.
  useEffect(() => startPlanPolling(controller, document), [controller]);
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
      ? "Could not refresh this account’s subscription limits. The last report is shown for reference; current allowance is unknown."
      : "Could not read this account’s subscription limits. Refresh to retry.";
    // A check time means Meta was asked and refused; without one the panel only knows no login is saved.
    case "login-required": return account.checkedAtMs === null
      ? "Sign in to this Muse account to check its subscription limits."
      : "Meta no longer accepts this login. Sign in again to see its subscription limits.";
    case "no-subscription": return "Meta reports no Muse subscription for this login. No subscription allowance is available to display.";
    case "not-reported": return account.checkedAtMs === null
      ? "Subscription limits have not been reported for this account. Refresh to check; missing values are unknown."
      : account.planName && account.usage
        // The last report is kept and shown above; Meta answered and named the plan but sent no new numbers.
        ? "Meta confirms your plan but is not sending usage numbers right now."
        : account.planName
        // Meta answered and named the plan but sent no numbers, which it does before the first use in a new window.
        ? "Meta confirms your plan but has not sent any usage numbers yet. This can happen before the first use in a new usage window: send a message in a thread that uses this account, then choose Refresh. If no numbers appear after that, Meta has not sent any for this account. Missing values are unknown, not zero usage."
        : "Meta did not report subscription limits for this account. Missing values are unknown, not zero usage.";
    case "runtime-only": return !account.usage
      ? "The Muse runtime has not reported subscription limits for this login. Current allowance is unknown."
      : account.source === "saved"
        ? "This is a saved reading. A current account check is unavailable, so the allowance may have changed."
        : account.source === "meta"
          // Meta's own reading, kept after the login lost the token that could check it again.
          ? "Last reported by Meta. A current account check is unavailable, so the allowance may have changed."
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
    {view ? <MeterDetails view={view} title={title} account={account} /> : <>
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

/**
 * Pure quota view. The last report is always shown, however old, and says what it is instead of passing for the
 * current allowance: a note under the limits explains what it means and how to get a current one.
 */
export function MeterDetails(props: { view: PlanView; title: string; saved?: boolean; account?: PlanAccountUsage }) {
  const { view, title, account } = props;
  const saved = props.saved || account?.source === "saved";
  const planName = account?.planName ?? view.tier;
  const source = saved ? "Saved reading" : account?.source === "meta" ? "Meta account" : "Muse runtime";
  // A saved reading is never the live meter, however recent: it stands as the last report.
  const rows = view.rows.map((row): PlanRow => saved && row.standing === "current" ? { ...row, current: false, standing: "last" } : row);
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <h3 className="font-medium text-muted">{title}</h3>
        {planName ? <span className="rounded-md bg-active px-1.5 py-px text-2xs text-muted">{planName}</span> : null}
        <span className="flex-1" />
        <time dateTime={new Date(view.observedAtMs).toISOString()} title={new Date(view.observedAtMs).toLocaleString()} className={cn("text-2xs", view.stale || saved ? "text-warn-text" : "text-subtle")}>
          {source} · {updatedLabel(view)}
        </time>
      </div>
      <div className="mt-3 grid gap-3 @min-[520px]:grid-cols-2">
        {rows.map((row) => <MeterRow key={row.key} row={row} reportedBy={account?.source === "meta" ? "Meta" : "Muse"} />)}
      </div>
      {rows.some((row) => row.standing !== "current") ? <LastReportNote view={view} rows={rows} /> : null}
    </div>
  );
}

/** One limit: a live meter only for a recent reading of an open window, otherwise the last report, labelled as such. */
function MeterRow(props: { row: PlanRow; reportedBy: string }) {
  const { row, reportedBy } = props;
  return (
    <div className="min-w-0 rounded-lg border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
        <span className="text-muted">{row.label}</span>
        <span className="flex-1" />
        <span className={cn("font-medium tabular-nums", row.standing === "current" ? TEXT[row.tone] : "text-subtle")}>
          {row.standing === "current" ? `${row.percent}% used` : row.standing === "last" ? `Last report: ${row.percent}% used` : row.key === "window" ? "Window ended" : "Week reset"}
        </span>
      </div>
      {row.standing === "current" ? <div role="progressbar" aria-label={`${row.label} used`} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={row.barPercent} aria-valuetext={`${row.percent}% used as last reported by ${reportedBy}`}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-active">
        <div className={cn("h-full rounded-full transition-[width] duration-300 ease-out", FILL[row.tone])} style={{ width: `${row.barPercent}%` }} />
      </div> : row.standing === "last" ? <div aria-hidden="true" className="mt-2 h-1.5 overflow-hidden rounded-full bg-active">
        <div className={cn("h-full rounded-full opacity-40", FILL[row.tone])} style={{ width: `${row.barPercent}%` }} />
      </div> : <p className="mt-2 text-2xs text-subtle tabular-nums">Last report: {row.percent}% used, before it {row.key === "window" ? "ended" : "reset"}.</p>}
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-2xs tabular-nums">
        <span className={cn(row.expired ? "text-warn-text" : "text-subtle")}>{row.resets}</span>
        {row.standing === "current" ? <span className="text-muted">{row.remainingPercent}% remaining at reading</span> : null}
      </div>
      <time dateTime={new Date(row.resetsAtMs).toISOString()} className="mt-1 block text-2xs text-subtle tabular-nums">
        {new Date(row.resetsAtMs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
      </time>
    </div>
  );
}

/**
 * What a report that is not current means, and how to get a current one. Meta sends usage numbers only while a 5-hour
 * window is running, and a window starts with the first message, so an old report is not a failure to read: nothing
 * newer exists until then. Where Refresh asks Meta again it is named; where only the Muse runtime reports it is not.
 */
function LastReportNote(props: { view: PlanView; rows: PlanRow[] }) {
  const { view, rows } = props;
  const when = view.age === "just now" ? "just now" : `${view.age} ago`;
  const ended = (key: PlanRow["key"]) => rows.some((row) => row.key === key && row.standing === "ended");
  return (
    <div className="mt-2 flex flex-col gap-1 text-2xs leading-5 text-subtle text-pretty">
      <p>
        These are the last numbers reported for this account, {when}.
        {rows.some((row) => row.standing === "last") ? " Usage may be higher now." : ""}
        {ended("window") ? " The 5-hour window has ended and a new one starts with your next message, so usage in it is unknown until then." : ""}
        {ended("weekly") ? " The weekly limit has reset since this report, so usage in the new week is unknown until Meta reports it." : ""}
        {" "}Meta sends usage numbers only while a 5-hour window is running, and a window starts with your first message.
      </p>
      <p>
        {view.refreshable
          ? "To get current numbers, send a message in a thread that uses this account, then choose Refresh. "
          : "To get current numbers, send a message in a thread that uses this account: Muse reports again when it next sends usage, and Refresh cannot update it. "}
        <MetaUsageLink /> always shows them.
      </p>
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

/** The reading's age in the short form the sidebar pill uses, so both surfaces describe the same reading alike. */
function updatedLabel(view: PlanView): string {
  return view.age === "just now" ? "Reported just now" : `Reported ${view.age} ago`;
}

/**
 * The current thread/project's account, led by the limit that binds. With no current limit it keeps the last report,
 * muted and marked with its age, rather than a dash: the figure is never dropped for being old.
 */
export function PlanPill() {
  const controller = useController();
  const accountId = useApp(contextualPlanAccountId);
  const account = useApp((s) => planAccount(s, accountId), shallowEqual);
  const name = useApp((s) => accountId === null ? "Default login" : s.accounts?.find((entry) => entry.id === accountId)?.name ?? accountId);
  const now = useNow(60_000, account.usage !== null);
  const view = planView(account.usage, now, account);
  if (!view) return null;
  // The percentage that matters is the one closest to the cap, not whichever window happens to come first.
  const binding = bindingRow(view);
  const last = binding ? null : lastKnownRow(view);
  const shown = binding ?? last;
  const label = `${name}. ` + (binding?.key === "weekly" ? "The pill shows the weekly limit, the highest of the limits with a current reading. " : "") +
    (last ? `No limit is current, so the pill shows the last report${last.key === "weekly" ? ", the weekly limit" : ""}. ` : "") +
    view.rows.map((row) => row.current
      ? `${row.label}: ${row.percent}% used, ${row.resets.toLowerCase()}`
      : `${row.label}: last reported ${row.percent}% used, ${row.resets.toLowerCase()}`).join(". ") +
    (last ? ". Send a message in a thread that uses this account to get current numbers" : "");
  return (
    <Tip label={`${label}. ${updatedLabel(view)}.`} side="top">
      <button type="button" aria-label={`Plan usage. ${label}`} onClick={() => controller.navigate({ kind: "usage" })}
        className={cn("inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-2xs font-medium tabular-nums transition-colors duration-100 hover:bg-hover", binding ? TEXT[binding.tone] : "text-subtle")}>
        <GaugeIcon size={12} />{shown ? <>{shown.percent}%{shown.key === "weekly" ? " wk" : ""}{last ? <span className="font-normal opacity-70"> · {view.age === "just now" ? "now" : view.age}</span> : null}</> : null}
      </button>
    </Tip>
  );
}
