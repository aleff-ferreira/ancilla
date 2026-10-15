import { ArrowLeftIcon } from "../ui/icons.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import { useOverlayDragProps } from "../../app/frame.js";
import { basename, formatDuration, formatTokens, modelDisplayName, relativeTime } from "../../model/format.js";
import { formatCost } from "../../model/pricing.js";
import { dayBasis, emptyRangeTitle, USAGE_RANGES } from "../../model/usage-range.js";
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

/** One colour per model, in the order they appear; the accent leads and the rest step away from it. */
const SERIES = [
  "var(--accent)",
  "color-mix(in oklch, var(--accent) 55%, var(--fg-muted))",
  "color-mix(in oklch, var(--accent) 30%, var(--fg-subtle))",
  "color-mix(in oklch, var(--ok) 70%, var(--fg-muted))",
  "color-mix(in oklch, var(--warn) 70%, var(--fg-muted))",
  "var(--fg-subtle)",
];

export function UsagePage() {
  const controller = useController();
  const models = useApp((s) => s.models);
  const sessions = useApp((s) => s.sessions);
  const sessionsLoaded = useApp((s) => s.sessionsLoaded);
  const [days, setDays] = useState<number>(30);
  const [loaded, setLoad] = useState<UsageLoad>(NO_LOAD);
  const { report, error } = loaded;
  // The warning's Retry reads quietly, so the numbers stay if it fails too; this shows it is working.
  const [retrying, setRetrying] = useState(false);
  // The newest request is the only one that may land: a late answer for another range, or an older refresh, is dropped.
  const request = useRef(0);
  const loadedAt = useRef<number | null>(null);
  // Ticks so the age beside the range buttons keeps counting between reads (and while reads are failing).
  const now = useNow(30_000);

  // A range change or Retry clears the page to the spinner; a silent refresh keeps what is on screen until the new
  // numbers arrive, and keeps it, marked as not refreshed, if they never do.
  const load = useCallback(
    (silent: boolean) => {
      const mine = ++request.current;
      loadedAt.current = Date.now();
      if (!silent) {
        setLoad(NO_LOAD);
      }
      controller
        .usageReport(days)
        .then((next) => mine === request.current && setLoad(loadSucceeded(next, Date.now())))
        .catch(
          (failure: unknown) =>
            mine === request.current && setLoad((current) => loadFailed(current, silent, failure instanceof Error ? failure.message : String(failure))),
        )
        .finally(() => mine === request.current && setRetrying(false));
    },
    [controller, days],
  );

  // A failed refresh leaves the numbers on screen, so its Retry reads quietly too: a second failure keeps them and the
  // warning instead of dropping the report it promised to keep.
  const retry = useCallback(() => {
    setRetrying(true);
    load(true);
  }, [load]);

  useEffect(() => {
    load(false);
    // Like the subscription meter above it: while the page is on screen, read again every minute and on coming back.
    const tick = () => {
      if (shouldRefresh(document.visibilityState, loadedAt.current, Date.now(), USAGE_REFRESH_MS / 2)) {
        load(true);
      }
    };
    const back = () => {
      if (shouldRefresh(document.visibilityState, loadedAt.current, Date.now())) {
        load(true);
      }
    };
    const timer = window.setInterval(tick, USAGE_REFRESH_MS);
    document.addEventListener("visibilitychange", back);
    return () => {
      request.current += 1;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [load]);

  const view = useMemo(() => (report ? summarize(report, models) : null), [report, models]);
  const collapsed = useApp((s) => s.prefs.sidebarCollapsed);
  const drag = useOverlayDragProps();

  return (
    <div className="@container flex h-full min-w-0 flex-col">
      {collapsed ? <TopBar /> : null}
      <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
      {/* The whole strip moves the window, as on the Settings page: on Windows only a `data-drag-region` surface does. */}
      <div data-drag-region {...drag} className="shrink-0">
      <header className="mx-auto flex w-full max-w-[980px] flex-wrap items-center gap-3 px-4 pt-6 pb-4 @min-[520px]:px-6 sm:pt-8">
        <Button size="sm" variant="ghost" onClick={() => controller.goBack()}>
          <ArrowLeftIcon size={14} /> Back
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-fg">Usage</h1>
          <p className="text-pretty text-xs text-muted">Muse subscription limits and activity in Ancilla.</p>
        </div>
      </header>
      </div>

      <div className="mx-auto w-full min-w-0 max-w-[980px] px-4 pb-16 @min-[520px]:px-6">
        <div className="mb-6">
          <PlanMeter />
        </div>
        <AccountMeters />
        <div className="mb-4 flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-fg">Thread activity</h2>
            <p className="mt-1 text-xs text-muted">Local token totals and API-rate estimates for this date range. These estimates are separate from your subscription allowance.</p>
          </div>
          <div className="flex w-full shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 @min-[520px]:ml-auto @min-[520px]:w-auto">
            <UpdatedAge load={loaded} now={now} />
            <div className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto rounded-lg bg-sunken p-0.5">
              {USAGE_RANGES.map((range) => (
                <button
                  key={range.days}
                  type="button"
                  onClick={() => setDays(range.days)}
                  aria-pressed={days === range.days}
                  className={cn(
                    "h-7 rounded-md px-2.5 text-xs font-medium transition-colors duration-100",
                    days === range.days ? "selected-control bg-raised text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {range.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <RefreshFailed load={loaded} now={now} busy={retrying} onRetry={retry} />
        {error ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-text">
            <p className="min-w-0 flex-1">{error}</p>
            <Button size="sm" variant="ghost" onClick={() => load(false)}>
              Retry
            </Button>
          </div>
        ) : !view ? (
          <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted">
            <Spinner size={13} /> Reading usage
          </div>
        ) : view.calls === 0 ? (
          <EmptyUsage days={days} view={view} />
        ) : (
          <UsageReportBody view={view} sessions={sessions} sessionsLoaded={sessionsLoaded} />
        )}
      </div>
      </div>
    </div>
  );
}

/** The age of the numbers on screen, beside the range buttons; nothing before the first read. */
export function UpdatedAge(props: { load: UsageLoad; now: number }) {
  const text = updatedLabel(props.load, props.now);
  return text ? <span className={cn("text-2xs whitespace-nowrap tabular-nums", props.load.refreshFailed ? "text-warn-text" : "text-subtle")}>{text}</span> : null;
}

/** The warning under the header when a quiet refresh failed: the numbers below are older than they look. */
export function RefreshFailed(props: { load: UsageLoad; now: number; busy?: boolean; onRetry: () => void }) {
  const text = refreshFailedNote(props.load, props.now);
  if (!text) {
    return null;
  }
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-warn-soft px-4 py-2.5 text-xs text-warn-text">
      <p className="min-w-0 flex-1">{text}</p>
      <Button size="sm" variant="ghost" loading={props.busy} onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** What a read of the report shows: the totals, then the chart, the models, the threads and what none of it counts. */
export function UsageReportBody(props: { view: UsageView; sessions: Readonly<Record<string, unknown>>; sessionsLoaded: boolean }) {
  const { view, sessions, sessionsLoaded } = props;
  // Threads the totals miss are said right under them, not only in the footer: the cards read as the whole spend.
  const missing = coverageNote(view.coverage);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Totals view={view} />
        {missing ? <p className="px-1 text-xs text-muted">{missing}</p> : null}
      </div>
      <DailyChart view={view} basis={dayBasis(view)} />
      <Models view={view} />
      <Threads view={view} sessions={sessions} sessionsLoaded={sessionsLoaded} />
      <div className="flex flex-col gap-1 text-xs text-subtle">
        <p>
          Prices are Meta's published rates per million tokens, or a model's own catalog price when it carries one. Contributor
          tiers are billed separately and marked as such.
        </p>
        <p>{coverageText(view.coverage)}</p>
        {view.allAccounts ? <p>{ACCOUNTS_NOTE}.</p> : null}
      </div>
    </div>
  );
}

function Card(props: { label: string; value: string; detail?: string; note?: { text: string; tip: string } }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-raised px-4 py-3 shadow-panel">
      <p className="text-xs font-medium text-muted">{props.label}</p>
      <p className="text-xl font-semibold text-fg tabular-nums">{props.value}</p>
      {props.detail ? <p className="text-2xs text-subtle tabular-nums">{props.detail}</p> : null}
      {props.note ? (
        <Tip label={props.note.tip}>
          <p tabIndex={0} className="text-2xs text-subtle tabular-nums">
            {props.note.text}
          </p>
        </Tip>
      ) : null}
    </div>
  );
}

export function Totals(props: { view: UsageView }) {
  const { view } = props;
  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card
        label="Cost at API rates"
        value={costBound(view.cost, view.currency, view.unpriced, view.calls)}
        detail={`${view.calls} model ${view.calls === 1 ? "call" : "calls"}`}
        note={
          view.unpriced > 0
            ? { text: unpricedCallsNote(view.unpriced, view.unpricedUnrecorded), tip: noPriceTip(view.unpriced, view.unpricedUnrecorded) }
            : undefined
        }
      />
      <Card label="Input tokens" value={formatTokens(view.promptTokens)} detail={`${formatTokens(view.cachedTokens)} served from cache`} />
      <Card
        label="Output tokens"
        value={formatTokens(view.outputTokens)}
        detail={view.reasoningTokens > 0 ? `${formatTokens(view.reasoningTokens)} reasoning` : undefined}
      />
      <Card
        label="Caching saved"
        value={costBound(view.cacheSaved, view.currency, view.unpriced, view.calls)}
        detail={view.modelMs > 0 ? `${formatDuration(view.modelMs)} of model time` : undefined}
      />
    </section>
  );
}

export function DailyChart(props: { view: UsageView; basis: { label: string; detail: string } }) {
  const { view, basis } = props;
  const tokens = view.metric === "tokens";
  // Dollars say nothing when not one call has a price, so the bars follow tokens then.
  const share = (row: { cost: number; tokens: number }) => (tokens ? row.tokens : row.cost);
  const max = Math.max(...view.days.map(share), tokens ? 1 : 0.000001);
  const order = view.models.map((m) => m.modelId);
  const last = view.days[view.days.length - 1]?.day ?? "";
  const counting = (day: string) => day === view.today;
  return (
    <section className="min-w-0 overflow-hidden rounded-xl bg-raised px-4 py-4 shadow-panel">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-fg">
          {tokens ? "Tokens by day" : "Cost by day"}{" "}
          <span title={basis.detail} className="font-normal text-subtle">
            ({basis.label})
          </span>
        </h2>
        <span className="text-2xs text-subtle tabular-nums">peak {tokens ? formatTokens(max) : formatCost(max, view.currency)}</span>
      </div>
      <div className="flex h-40 min-w-0 items-end gap-px overflow-hidden">
        {view.days.map((day) => (
          <div key={day.day} className="flex h-full min-w-0 flex-1 flex-col justify-end">
            <Tip
              label={`${day.day}${counting(day.day) ? " (today so far)" : ""}: ${
                tokens ? `${formatTokens(day.tokens)} tokens` : costBound(day.cost, view.currency, day.unpricedCalls, day.calls)
              }`}
            >
              <div
                tabIndex={0}
                className={cn(
                  "group/bar flex h-full w-full min-w-0 flex-col justify-end rounded-t-[3px]",
                  counting(day.day) && view.days.length > 1 && "opacity-70",
                )}
              >
                {day.byModel
                  .slice()
                  .sort((a, b) => order.indexOf(a.modelId) - order.indexOf(b.modelId))
                  .map((slice) => (
                    <div
                      key={slice.modelId}
                      style={{
                        height: `${Math.max((share(slice) / max) * 100, share(slice) > 0 ? 1.5 : 0)}%`,
                        background: SERIES[Math.max(0, order.indexOf(slice.modelId)) % SERIES.length],
                      }}
                      className="w-full first:rounded-t-[3px] transition-opacity duration-100 group-hover/bar:opacity-80"
                    />
                  ))}
              </div>
            </Tip>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-2xs text-subtle tabular-nums">
        <span>{view.days.length > 1 ? (view.days[0]?.day ?? "") : ""}</span>
        <span>
          {last}
          {counting(last) ? " (today so far)" : ""}
        </span>
      </div>
      {!tokens && view.unpriced > 0 ? (
        <Tip label={unpricedReason(view.unpriced, view.unpricedUnrecorded)}>
          <p tabIndex={0} className="mt-1 text-2xs text-subtle">
            Cost {excludedCallsNote(view.unpriced, view.unpricedUnrecorded)}
          </p>
        </Tip>
      ) : null}
    </section>
  );
}

export function Models(props: { view: UsageView }) {
  const { view } = props;
  const tokens = view.metric === "tokens";
  const max = Math.max(...view.models.map((m) => (tokens ? m.tokens : m.cost)), tokens ? 1 : 0.000001);
  return (
    <section className="rounded-xl bg-raised px-4 py-4 shadow-panel">
      <h2 className="mb-3 text-sm font-medium text-fg">By model</h2>
      <div className="flex flex-col gap-3">
        {view.models.map((model, index) => (
          <div key={model.modelId} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span className="size-2 shrink-0 rounded-[3px]" style={{ background: SERIES[index % SERIES.length] }} aria-hidden="true" />
                <span className="truncate text-sm text-fg">{modelDisplayName(model.modelId)}</span>
                {model.contributor ? (
                  <span className="shrink-0 rounded bg-active px-1 py-px text-2xs font-medium text-muted">contributor</span>
                ) : null}
              </div>
              <span className="shrink-0 text-sm text-fg tabular-nums">
                {tokens ? `${formatTokens(model.tokens)} tokens` : costBound(model.cost, view.currency, model.unpricedCalls, model.calls)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(((tokens ? model.tokens : model.cost) / max) * 100, 2)}%`, background: SERIES[index % SERIES.length] }}
              />
            </div>
            <p className="text-2xs text-subtle tabular-nums">
              {model.calls} calls · {formatTokens(model.promptTokens)} in ({formatTokens(model.cachedTokens)} cached) ·{" "}
              {formatTokens(model.outputTokens)} out
              {model.price
                ? ` · ${formatCost(model.price.input, view.currency)}/M in, ${formatCost(model.price.output, view.currency)}/M out`
                : ` · ${noPriceCaption(model.modelId)}`}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** `note` is the row's price caveat, or null when there is none to show. An openable row is a button whose own tooltip
 * carries it, so no second tab stop is nested inside the button. */
function ThreadLine(props: { thread: ThreadRow; view: UsageView; openable: boolean; note: string | null }) {
  const { thread, view, openable, note } = props;
  const tokens = view.metric === "tokens";
  const value = tokens ? `${formatTokens(thread.tokens)} tokens` : costBound(thread.cost, view.currency, thread.unpricedCalls, thread.calls);
  return (
    <>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-fg">{thread.title ?? "New thread"}</p>
        <p className="truncate text-2xs text-subtle tabular-nums">
          {thread.cwd ? `${basename(thread.cwd)} · ` : ""}
          {thread.calls} calls · {tokens ? "" : `${formatTokens(thread.tokens)} tokens · `}
          {relativeTime(thread.lastAt)}
          {thread.kind === "research" ? " · not a thread" : openable ? "" : " · not in your thread list"}
        </p>
      </div>
      {note && !openable ? (
        <Tip label={note}>
          <span tabIndex={0} className="shrink-0 text-sm text-fg tabular-nums">
            {value}
          </span>
        </Tip>
      ) : (
        <span className="shrink-0 text-sm text-fg tabular-nums">{value}</span>
      )}
    </>
  );
}

/** The row that opens its thread. A price caveat rides on the button's own tooltip, which is also its one tab stop. */
function ThreadButton(props: { note: string | null; onOpen: () => void; children: ReactNode }) {
  const button = (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors duration-100 hover:bg-hover"
    >
      {props.children}
    </button>
  );
  return props.note ? (
    <Tip label={props.note} align="end">
      {button}
    </Tip>
  ) : (
    button
  );
}

export function Threads(props: { view: UsageView; sessions: Readonly<Record<string, unknown>>; sessionsLoaded: boolean }) {
  const controller = useController();
  const { view, sessions, sessionsLoaded } = props;
  if (view.threads.length === 0) {
    return null;
  }
  const cut = threadsCutNote(view);
  return (
    <section className="rounded-xl bg-raised px-4 py-4 shadow-panel">
      <h2 className="mb-3 text-sm font-medium text-fg">{view.metric === "tokens" ? "Busiest threads" : "Costliest threads"}</h2>
      <ul className="flex flex-col">
        {view.threads.map((thread) => {
          const openable = threadOpenable(thread, sessions, sessionsLoaded);
          // Tokens are all there is to say in tokens mode, so only a cost has a price caveat.
          const note = view.metric === "tokens" ? null : threadPriceNote(thread);
          return (
            <li key={thread.sessionId}>
              {openable ? (
                <ThreadButton note={note} onOpen={() => controller.openThread(thread.sessionId)}>
                  <ThreadLine thread={thread} view={view} openable note={note} />
                </ThreadButton>
              ) : (
                // No page to open: the folded DeepResearch row, or a thread that is archived.
                <div className="flex w-full items-center gap-3 px-2 py-2">
                  <ThreadLine thread={thread} view={view} openable={false} note={note} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {cut ? <p className="mt-2 px-2 text-2xs text-subtle tabular-nums">{cut}</p> : null}
    </section>
  );
}

function EmptyUsage(props: { days: number; view: UsageView }) {
  // Threads that ran in the window but were never read back are why a window can look empty.
  const note = coverageNote(props.view.coverage);
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl bg-raised px-6 py-16 text-center shadow-panel">
      <p className="text-sm font-medium text-fg">{emptyRangeTitle(props.days)}</p>
      <p className="max-w-[42ch] text-xs text-muted">
        This fills in as threads run. Opening an older thread also backfills what it spent, so its calls show up here too.
      </p>
      {note ? <p className="max-w-[48ch] text-xs text-subtle">{note}</p> : null}
    </div>
  );
}
