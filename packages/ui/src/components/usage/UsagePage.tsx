import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import { useOverlayDragProps } from "../../app/frame.js";
import { basename, formatDuration, formatTokens, modelDisplayName, relativeTime } from "../../model/format.js";
import { formatCost } from "../../model/pricing.js";
import { dayBasis, emptyRangeTitle, USAGE_RANGES } from "../../model/usage-range.js";
import type { ProviderQuotaView } from "../../types.js";
import {
  ACCOUNTS_NOTE,
  costBound,
  coverageNote,
  coverageText,
  excludedCallsNote,
  loadFailed,
  loadSucceeded,
  noPriceCaption,
  noPriceTip,
  NO_LOAD,
  refreshFailedNote,
  shouldRefresh,
  summarize,
  threadOpenable,
  threadPriceNote,
  threadsCutNote,
  unpricedCallsNote,
  unpricedReason,
  updatedLabel,
  USAGE_REFRESH_MS,
  type ThreadRow,
  type UsageLoad,
  type UsageView,
} from "../../model/usage-report.js";
import { Button, Spinner, cn } from "../ui/primitives.js";
import { TopBar } from "../chrome.js";
import { AccountMeters, PlanMeter } from "./PlanMeter.js";
import { Tip } from "../ui/overlays.js";
import { ArrowLeftIcon, ArrowSquareOutIcon } from "../ui/icons.js";

const MODEL_PALETTE = [
  "var(--accent)",
  "color-mix(in oklch, var(--accent) 54%, var(--fg-muted))",
  "color-mix(in oklch, var(--accent) 32%, var(--fg-subtle))",
  "color-mix(in oklch, var(--ok) 68%, var(--fg-muted))",
  "color-mix(in oklch, var(--warn) 68%, var(--fg-muted))",
  "var(--fg-subtle)",
];

function resolveModelColor(idx: number): string {
  return MODEL_PALETTE[Math.max(0, idx) % MODEL_PALETTE.length];
}

export function UsagePage() {
  const ctrl = useController();
  const knownModels = useApp((s) => s.models);
  const sessionRegistry = useApp((s) => s.sessions);
  const areSessionsLoaded = useApp((s) => s.sessionsLoaded);

  const [dateRangeDays, setDateRangeDays] = useState<number>(30);
  const [loadPayload, setLoadPayload] = useState<UsageLoad>(NO_LOAD);
  const { report: activeReport, error: loadErrorMessage } = loadPayload;
  const [isRetryingSync, setIsRetryingSync] = useState(false);

  const activeReqId = useRef(0);
  const lastFetchedEpoch = useRef<number | null>(null);
  const liveTicker = useNow(30_000);

  const executeFetch = useCallback(
    (isBackground: boolean) => {
      const ticket = ++activeReqId.current;
      lastFetchedEpoch.current = Date.now();
      if (!isBackground) setLoadPayload(NO_LOAD);

      ctrl
        .usageReport(dateRangeDays)
        .then((data) => {
          if (ticket === activeReqId.current) setLoadPayload(loadSucceeded(data, Date.now()));
        })
        .catch((err: unknown) => {
          if (ticket === activeReqId.current) {
            const msg = err instanceof Error ? err.message : String(err);
            setLoadPayload((prev) => loadFailed(prev, isBackground, msg));
          }
        })
        .finally(() => {
          if (ticket === activeReqId.current) setIsRetryingSync(false);
        });
    },
    [ctrl, dateRangeDays],
  );

  const handleManualRetry = useCallback(() => {
    setIsRetryingSync(true);
    executeFetch(true);
  }, [executeFetch]);

  useEffect(() => {
    executeFetch(false);

    const onInterval = () => {
      if (shouldRefresh(document.visibilityState, lastFetchedEpoch.current, Date.now(), USAGE_REFRESH_MS / 2)) {
        executeFetch(true);
      }
    };
    const onVisibility = () => {
      if (shouldRefresh(document.visibilityState, lastFetchedEpoch.current, Date.now())) {
        executeFetch(true);
      }
    };

    const intervalTimer = window.setInterval(onInterval, USAGE_REFRESH_MS);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      activeReqId.current += 1;
      window.clearInterval(intervalTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [executeFetch]);

  const reportSummary = useMemo(
    () => (activeReport ? summarize(activeReport, knownModels) : null),
    [activeReport, knownModels],
  );
  const isNavCollapsed = useApp((s) => s.prefs.sidebarCollapsed);
  const windowDragHandlers = useOverlayDragProps();

  return (
    <div className="@container flex h-full min-w-0 flex-col">
      {isNavCollapsed && <TopBar />}
      <div className="flex-1 min-w-0 overflow-x-hidden overflow-y-auto">
        <div data-drag-region {...windowDragHandlers} className="shrink-0">
          <header className="mx-auto flex w-full max-w-[980px] flex-wrap items-center gap-3 px-4 pt-6 pb-4 @min-[520px]:px-6 sm:pt-8">
            <Button size="sm" variant="ghost" onClick={() => ctrl.goBack()}>
              <ArrowLeftIcon size={14} /> Back
            </Button>
            <div className="flex-1 min-w-0">
              <h1 className="text-lg font-semibold text-fg">Usage</h1>
              <p className="text-pretty text-xs text-muted">Muse subscription limits and activity in Ancilla.</p>
            </div>
          </header>
        </div>

        <main className="mx-auto w-full min-w-0 max-w-[980px] px-4 pb-16 @min-[520px]:px-6">
          <div className="mb-6"><PlanMeter /></div>
          <AccountMeters />
          <ProviderQuotasSection />

          <section className="mb-4 flex flex-wrap items-center gap-3 border-t border-line pt-5">
            <div className="flex-1 min-w-0">
              <h2 className="text-sm font-medium text-fg">Thread activity</h2>
              <p className="mt-1 text-xs text-muted">
                Local token totals and API-rate estimates for this date range. These estimates are separate from your subscription allowance.
              </p>
            </div>
            <div className="flex w-full shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 @min-[520px]:ml-auto @min-[520px]:w-auto">
              <UpdatedAge load={loadPayload} now={liveTicker} />
              <div className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto rounded-lg bg-sunken p-0.5">
                {USAGE_RANGES.map((span) => (
                  <button
                    key={span.days}
                    type="button"
                    onClick={() => setDateRangeDays(span.days)}
                    aria-pressed={dateRangeDays === span.days}
                    className={cn(
                      "h-7 rounded-md px-2.5 text-xs font-medium transition-colors duration-100",
                      dateRangeDays === span.days ? "selected-control bg-raised text-fg" : "text-muted hover:text-fg",
                    )}
                  >{span.label}</button>
                ))}
              </div>
            </div>
          </section>

          <RefreshFailed load={loadPayload} now={liveTicker} busy={isRetryingSync} onRetry={handleManualRetry} />

          {loadErrorMessage ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-text">
              <p className="flex-1 min-w-0">{loadErrorMessage}</p>
              <Button size="sm" variant="ghost" onClick={() => executeFetch(false)}>Retry</Button>
            </div>
          ) : !reportSummary ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted">
              <Spinner size={13} /> Reading usage
            </div>
          ) : reportSummary.calls === 0 ? (
            <EmptyUsage days={dateRangeDays} view={reportSummary} />
          ) : (
            <UsageReportBody view={reportSummary} sessions={sessionRegistry} sessionsLoaded={areSessionsLoaded} />
          )}
        </main>
      </div>
    </div>
  );
}

export function UpdatedAge(props: { load: UsageLoad; now: number }) {
  const labelText = updatedLabel(props.load, props.now);
  if (!labelText) return null;
  return (
    <span className={cn("text-2xs whitespace-nowrap tabular-nums", props.load.refreshFailed ? "text-warn-text" : "text-subtle")}>
      {labelText}
    </span>
  );
}

export function RefreshFailed(props: { load: UsageLoad; now: number; busy?: boolean; onRetry: () => void }) {
  const warnText = refreshFailedNote(props.load, props.now);
  if (!warnText) return null;

  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-warn-soft px-4 py-2.5 text-xs text-warn-text">
      <p className="flex-1 min-w-0">{warnText}</p>
      <Button size="sm" variant="ghost" loading={props.busy} onClick={props.onRetry}>Retry</Button>
    </div>
  );
}

export function UsageReportBody(props: {
  view: UsageView;
  sessions: Readonly<Record<string, unknown>>;
  sessionsLoaded: boolean;
}) {
  const { view, sessions, sessionsLoaded } = props;
  const missingSummary = coverageNote(view.coverage);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Totals view={view} />
        {missingSummary && <p className="px-1 text-xs text-muted">{missingSummary}</p>}
      </div>
      <DailyChart view={view} basis={dayBasis(view)} />
      <Models view={view} />
      <Threads view={view} sessions={sessions} sessionsLoaded={sessionsLoaded} />
      <footer className="flex flex-col gap-1 text-xs text-subtle">
        <p>
          Prices are Meta's published rates per million tokens, or a model's own catalog price when it carries one. Contributor
          tiers are billed separately and marked as such.
        </p>
        <p>{coverageText(view.coverage)}</p>
        {view.allAccounts && <p>{ACCOUNTS_NOTE}.</p>}
      </footer>
    </div>
  );
}

function MetricSummaryCard(props: {
  label: string;
  value: string;
  detail?: string;
  note?: { text: string; tip: string };
}) {
  return (
    <article className="flex flex-col gap-1 rounded-xl bg-raised px-4 py-3 shadow-panel">
      <p className="text-xs font-medium text-muted">{props.label}</p>
      <p className="text-xl font-semibold text-fg tabular-nums">{props.value}</p>
      {props.detail && <p className="text-2xs text-subtle tabular-nums">{props.detail}</p>}
      {props.note && (
        <Tip label={props.note.tip}>
          <p tabIndex={0} className="text-2xs text-subtle tabular-nums">{props.note.text}</p>
        </Tip>
      )}
    </article>
  );
}

export function Totals(props: { view: UsageView }) {
  const { view } = props;
  const callsDescriptor = `${view.calls} model ${view.calls === 1 ? "call" : "calls"}`;
  const unpricedCaveat = view.unpriced > 0 ? {
    text: unpricedCallsNote(view.unpriced, view.unpricedUnrecorded),
    tip: noPriceTip(view.unpriced, view.unpricedUnrecorded),
  } : undefined;
  const reasoningNote = view.reasoningTokens > 0 ? `${formatTokens(view.reasoningTokens)} reasoning` : undefined;
  const cacheDurationNote = view.modelMs > 0 ? `${formatDuration(view.modelMs)} of model time` : undefined;

  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <MetricSummaryCard
        label="Cost at API rates"
        value={costBound(view.cost, view.currency, view.unpriced, view.calls)}
        detail={callsDescriptor}
        note={unpricedCaveat}
      />
      <MetricSummaryCard
        label="Input tokens"
        detail={`${formatTokens(view.cachedTokens)} served from cache`}
        value={formatTokens(view.promptTokens)}
      />
      <MetricSummaryCard
        label="Output tokens"
        detail={reasoningNote}
        value={formatTokens(view.outputTokens)}
      />
      <MetricSummaryCard
        label="Caching saved"
        detail={cacheDurationNote}
        value={costBound(view.cacheSaved, view.currency, view.unpriced, view.calls)}
      />
    </section>
  );
}

export function DailyChart(props: { view: UsageView; basis: { label: string; detail: string } }) {
  const { view, basis } = props;
  const isTokenMetric = view.metric === "tokens";
  const measure = (item: { cost: number; tokens: number }) => (isTokenMetric ? item.tokens : item.cost);
  const peakVal = Math.max(...view.days.map(measure), isTokenMetric ? 1 : 0.000001);
  const modelSeq = view.models.map((m) => m.modelId);
  const tailDay = view.days[view.days.length - 1]?.day ?? "";
  const isTodayDate = (d: string) => d === view.today;

  return (
    <section className="min-w-0 overflow-hidden rounded-xl bg-raised px-4 py-4 shadow-panel">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-fg">
          {isTokenMetric ? "Tokens by day" : "Cost by day"}{" "}
          <span title={basis.detail} className="font-normal text-subtle">({basis.label})</span>
        </h2>
        <span className="text-2xs text-subtle tabular-nums">
          peak {isTokenMetric ? formatTokens(peakVal) : formatCost(peakVal, view.currency)}
        </span>
      </header>

      <div className="flex h-40 min-w-0 items-end gap-px overflow-hidden">
        {view.days.map((bucketDay) => {
          const isTodayBucket = isTodayDate(bucketDay.day);
          const tooltipContent = `${bucketDay.day}${isTodayBucket ? " (today so far)" : ""}: ${
            isTokenMetric
              ? `${formatTokens(bucketDay.tokens)} tokens`
              : costBound(bucketDay.cost, view.currency, bucketDay.unpricedCalls, bucketDay.calls)
          }`;

          const sortedSegments = bucketDay.byModel
            .slice()
            .sort((a, b) => modelSeq.indexOf(a.modelId) - modelSeq.indexOf(b.modelId));

          return (
            <div key={bucketDay.day} className="flex h-full min-w-0 flex-1 flex-col justify-end">
              <Tip label={tooltipContent}>
                <div
                  tabIndex={0}
                  className={cn(
                    "group/bar flex h-full w-full min-w-0 flex-col justify-end rounded-t-[3px]",
                    isTodayBucket && view.days.length > 1 && "opacity-70",
                  )}
                >
                  {sortedSegments.map((segment) => {
                    const segHeight = Math.max((measure(segment) / peakVal) * 100, measure(segment) > 0 ? 1.5 : 0);
                    const colorFill = resolveModelColor(modelSeq.indexOf(segment.modelId));
                    return (
                      <div
                        key={segment.modelId}
                        style={{ height: `${segHeight}%`, background: colorFill }}
                        className="w-full first:rounded-t-[3px] transition-opacity duration-100 group-hover/bar:opacity-80"
                      />
                    );
                  })}
                </div>
              </Tip>
            </div>
          );
        })}
      </div>

      <footer className="mt-2 flex items-center justify-between text-2xs text-subtle tabular-nums">
        <span>{view.days.length > 1 ? (view.days[0]?.day ?? "") : ""}</span>
        <span>{tailDay}{isTodayDate(tailDay) ? " (today so far)" : ""}</span>
      </footer>

      {!isTokenMetric && view.unpriced > 0 && (
        <Tip label={unpricedReason(view.unpriced, view.unpricedUnrecorded)}>
          <p tabIndex={0} className="mt-1 text-2xs text-subtle">
            Cost {excludedCallsNote(view.unpriced, view.unpricedUnrecorded)}
          </p>
        </Tip>
      )}
    </section>
  );
}

export function Models(props: { view: UsageView }) {
  const { view } = props;
  const isTokenMetric = view.metric === "tokens";
  const ceiling = Math.max(...view.models.map((m) => (isTokenMetric ? m.tokens : m.cost)), isTokenMetric ? 1 : 0.000001);

  return (
    <section className="rounded-xl bg-raised px-4 py-4 shadow-panel">
      <h2 className="mb-3 text-sm font-medium text-fg">By model</h2>
      <div className="flex flex-col gap-3">
        {view.models.map((modelRecord, idx) => {
          const modelVal = isTokenMetric ? modelRecord.tokens : modelRecord.cost;
          const barFraction = Math.max((modelVal / ceiling) * 100, 2);
          const barHue = resolveModelColor(idx);

          return (
            <article key={modelRecord.modelId} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className="size-2 shrink-0 rounded-[3px]" style={{ background: barHue }} aria-hidden="true" />
                  <span className="truncate text-sm text-fg">{modelDisplayName(modelRecord.modelId)}</span>
                  {modelRecord.contributor && (
                    <span className="shrink-0 rounded bg-active px-1 py-px text-2xs font-medium text-muted">contributor</span>
                  )}
                </div>
                <span className="shrink-0 text-sm text-fg tabular-nums">
                  {isTokenMetric
                    ? `${formatTokens(modelRecord.tokens)} tokens`
                    : costBound(modelRecord.cost, view.currency, modelRecord.unpricedCalls, modelRecord.calls)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
                <div className="h-full rounded-full" style={{ width: `${barFraction}%`, background: barHue }} />
              </div>
              <p className="text-2xs text-subtle tabular-nums">
                {modelRecord.calls} calls · {formatTokens(modelRecord.promptTokens)} in ({formatTokens(modelRecord.cachedTokens)} cached) ·{" "}
                {formatTokens(modelRecord.outputTokens)} out
                {modelRecord.price
                  ? ` · ${formatCost(modelRecord.price.input, view.currency)}/M in, ${formatCost(modelRecord.price.output, view.currency)}/M out`
                  : ` · ${noPriceCaption(modelRecord.modelId)}`}
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ThreadRowDetail(props: { thread: ThreadRow; view: UsageView; openable: boolean; note: string | null }) {
  const { thread, view, openable, note } = props;
  const isTokenMode = view.metric === "tokens";
  const statFormatted = isTokenMode
    ? `${formatTokens(thread.tokens)} tokens`
    : costBound(thread.cost, view.currency, thread.unpricedCalls, thread.calls);

  return (
    <>
      <div className="flex-1 min-w-0">
        <p className="truncate text-sm text-fg">{thread.title ?? "New thread"}</p>
        <p className="truncate text-2xs text-subtle tabular-nums">
          {thread.cwd ? `${basename(thread.cwd)} · ` : ""}
          {thread.calls} calls · {isTokenMode ? "" : `${formatTokens(thread.tokens)} tokens · `}
          {relativeTime(thread.lastAt)}
          {thread.kind === "research" ? " · not a thread" : openable ? "" : " · not in your thread list"}
        </p>
      </div>
      {note && !openable ? (
        <Tip label={note}>
          <span tabIndex={0} className="shrink-0 text-sm text-fg tabular-nums">{statFormatted}</span>
        </Tip>
      ) : (
        <span className="shrink-0 text-sm text-fg tabular-nums">{statFormatted}</span>
      )}
    </>
  );
}

function OpenableThreadButton(props: { note: string | null; onOpen: () => void; children: ReactNode }) {
  const triggerButton = (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors duration-100 hover:bg-hover"
    >
      {props.children}
    </button>
  );

  return props.note ? (
    <Tip label={props.note} align="end">{triggerButton}</Tip>
  ) : (
    triggerButton
  );
}

export function Threads(props: {
  view: UsageView;
  sessions: Readonly<Record<string, unknown>>;
  sessionsLoaded: boolean;
}) {
  const ctrl = useController();
  const { view, sessions, sessionsLoaded } = props;

  if (view.threads.length === 0) return null;
  const truncatedSummary = threadsCutNote(view);

  return (
    <section className="rounded-xl bg-raised px-4 py-4 shadow-panel">
      <h2 className="mb-3 text-sm font-medium text-fg">
        {view.metric === "tokens" ? "Busiest threads" : "Costliest threads"}
      </h2>
      <ul className="flex flex-col list-none p-0 m-0">
        {view.threads.map((rowItem) => {
          const isOpenableSession = threadOpenable(rowItem, sessions, sessionsLoaded);
          const priceCaveat = view.metric === "tokens" ? null : threadPriceNote(rowItem);

          return (
            <li key={rowItem.sessionId}>
              {isOpenableSession ? (
                <OpenableThreadButton note={priceCaveat} onOpen={() => ctrl.openThread(rowItem.sessionId)}>
                  <ThreadRowDetail thread={rowItem} view={view} openable note={priceCaveat} />
                </OpenableThreadButton>
              ) : (
                <div className="flex w-full items-center gap-3 px-2 py-2">
                  <ThreadRowDetail thread={rowItem} view={view} openable={false} note={priceCaveat} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {truncatedSummary && <p className="mt-2 px-2 text-2xs text-subtle tabular-nums">{truncatedSummary}</p>}
    </section>
  );
}

function EmptyUsage(props: { days: number; view: UsageView }) {
  const coverageDetails = coverageNote(props.view.coverage);
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl bg-raised px-6 py-16 text-center shadow-panel">
      <p className="text-sm font-medium text-fg">{emptyRangeTitle(props.days)}</p>
      <p className="max-w-[42ch] text-xs text-muted">
        This fills in as threads run. Opening an older thread also backfills what it spent, so its calls show up here too.
      </p>
      {coverageDetails && <p className="max-w-[48ch] text-xs text-subtle">{coverageDetails}</p>}
    </div>
  );
}

export function ProviderQuotasSection() {
  const quotaEntries = useApp((s) => s.providerQuotas ?? []);
  if (quotaEntries.length === 0) return null;

  return (
    <section aria-label="Other AI subscriptions and endpoints" className="mb-6 border-t border-line pt-5">
      <div className="mb-3">
        <h2 className="text-sm font-medium text-fg">Other AI subscriptions &amp; endpoints</h2>
        <p className="mt-1 text-xs text-muted">
          Allowance readings reported directly by official CLIs over stdio, alongside official dashboard links where numeric percentages are not exposed.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {quotaEntries.map((entry) => (
          <ProviderQuotaCard key={`${entry.providerId}:${entry.accountId ?? "default"}`} quota={entry} />
        ))}
      </div>
    </section>
  );
}

function ProviderQuotaCard(props: { quota: ProviderQuotaView }) {
  const { quota } = props;
  const cardTitle = quota.accountName ? `${quota.displayName} · ${quota.accountName}` : quota.displayName;
  const activeTier = quota.usage?.tier ?? null;

  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-raised px-4 py-3.5 shadow-panel">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{cardTitle}</span>
          {activeTier && (
            <span className="shrink-0 rounded bg-active px-1.5 py-0.5 text-2xs font-medium text-muted uppercase">
              {activeTier}
            </span>
          )}
        </div>
        {quota.usageDashboardUrl && (
          <a
            href={quota.usageDashboardUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand-text underline-offset-2 hover:underline"
          >
            Usage dashboard <ArrowSquareOutIcon size={11} />
          </a>
        )}
      </header>

      {quota.quotaSupport === "windows" ? (
        quota.usage ? (
          <div className="flex flex-col gap-2">
            <QuotaWindowBar label="5-hour window" usedPercent={quota.usage.window.usedPercent} />
            <QuotaWindowBar label="Weekly limit" usedPercent={quota.usage.weekly.usedPercent} />
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-muted">
            No live rate-limit window reported yet. Send a message in a thread using this login to observe its current 5-hour and weekly limits.
          </p>
        )
      ) : quota.quotaSupport === "tier-only" ? (
        <p className="text-xs leading-relaxed text-muted">
          This CLI does not expose numeric remaining percentages over stdio. Check the official usage dashboard for current subscription limits.
        </p>
      ) : (
        <p className="text-xs leading-relaxed text-muted">
          Pay-as-you-go API or local endpoint. Token counts and list-price estimates are included in the thread activity report below.
        </p>
      )}
    </div>
  );
}

function QuotaWindowBar(props: { label: string; usedPercent: number }) {
  const usedVal = Math.max(0, Math.round(props.usedPercent));
  const remainingVal = Math.max(0, 100 - usedVal);
  const clampedWidth = Math.min(100, usedVal);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-2xs tabular-nums">
        <span className="text-muted">{props.label}</span>
        <span className="text-fg">{usedVal}% used · {remainingVal}% left</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
        <div
          className={cn("h-full rounded-full", usedVal >= 90 ? "bg-danger" : usedVal >= 75 ? "bg-warn" : "bg-accent")}
          style={{ width: `${clampedWidth}%` }}
        />
      </div>
    </div>
  );
}
