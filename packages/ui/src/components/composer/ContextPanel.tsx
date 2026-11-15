import { CaretDownIcon, CaretRightIcon } from "../ui/icons.js";
import { Popover } from "radix-ui";
import { useMemo, useState, type ReactNode } from "react";
import { useApp, useController } from "../../app/context.js";
import { formatDuration, formatTokens, modelDisplayName } from "../../model/format.js";
import { formatCost } from "../../model/pricing.js";
import { contextBreakdown, contextUsageOf, sessionUsage, type ContextBreakdown, type SessionUsage, type SliceKey } from "../../model/usage.js";
import { breakdownNote, contextCostValue, contextMeterView, contextTokenRows, costTitle, LOADED_ONLY, pressureNote, segmentBarLabel, share, SUBAGENT_CAPTION, unpricedWhy, type ContextTone } from "../../model/usage-labels.js";
import { Tip, FLOATING } from "../ui/overlays.js";
import { cn } from "../ui/primitives.js";
import { Collapse } from "../ui/sourced.js";

function resolveSliceColor(key: SliceKey): string {
  switch (key) {
    case "prompts": return "bg-chart-1";
    case "replies": return "bg-chart-2";
    case "tools": return "bg-chart-3";
    case "subagents": return "bg-chart-4";
    case "summary": return "bg-chart-6";
    default: return "bg-chart-5";
  }
}

function formatSessionDuration(ms: number): string {
  return ms > 0 ? (formatDuration(ms) ?? "0s") : "0s";
}

function ContextRingSvg({ radius, fill, tone }: { radius: number; fill: number; tone: ContextTone }) {
  const perimeter = 2 * Math.PI * radius;
  const dashLength = Math.max(perimeter * fill, fill > 0 ? 1.2 : 0);
  const toneClass = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-accent-text";
  return (<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="-rotate-90"><circle cx="8" cy="8" r={radius} fill="none" stroke="var(--border-strong)" strokeWidth="2" /><circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${dashLength} ${perimeter}`} className={toneClass} /></svg>);
}

function ContextMeterTrigger({ view }: { view: ReturnType<typeof contextMeterView> }) {
  return (<Tip label={view.tip}><Popover.Trigger asChild><button type="button" aria-label={view.aria} className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-2xs text-subtle tabular-nums transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg"><ContextRingSvg radius={6} fill={view.fill ?? 0} tone={view.tone} />{view.text}</button></Popover.Trigger></Tip>);
}

function ContextPopoverSurface({ sessionId }: { sessionId: string }) {
  const surfaceStyle = "pop z-[var(--z-dropdown)] max-h-[var(--radix-popover-content-available-height)] w-[360px] max-w-[calc(100dvw-24px)] overflow-y-auto rounded-xl bg-raised text-fg shadow-pop outline-none";
  return (<Popover.Portal><Popover.Content side="top" align="end" sideOffset={6} className={surfaceStyle} {...FLOATING}><ContextPanel sessionId={sessionId} /></Popover.Content></Popover.Portal>);
}

export function ContextMeter({ sessionId }: { sessionId: string }) {
  const usage = useApp(
    (s) => {
      const active = s.threads[sessionId];
      return active?.fold ? contextUsageOf(active.fold, s.models) : null;
    },
    (prev, next) => prev?.usedTokens === next?.usedTokens && prev?.windowTokens === next?.windowTokens && prev?.pressure === next?.pressure,
  );

  if (!usage) return null;

  const view = contextMeterView(usage);
  return (<Popover.Root><ContextMeterTrigger view={view} /><ContextPopoverSurface sessionId={sessionId} /></Popover.Root>);
}

export function ContextPanel({ sessionId }: { sessionId: string }) {
  const controller = useController();
  const threadState = useApp((s) => s.threads[sessionId] ?? null);
  const catalog = useApp((s) => s.models);

  const fold = threadState?.fold ?? null;
  const isReadOnly = Boolean(threadState?.readOnly);
  const isTruncated = threadState?.truncated ?? false;

  const breakdown = useMemo(() => (fold ? contextBreakdown(fold, catalog) : null), [fold, catalog]);
  const usage = useMemo(() => (fold ? sessionUsage(fold, catalog, isTruncated) : null), [fold, catalog, isTruncated]);

  if (!breakdown || !usage) return null;

  return (
    <div className="flex flex-col">
      <ContextWindowSection
        breakdown={breakdown}
        usage={usage}
        readOnly={isReadOnly}
        onCompact={() => void controller.compact(sessionId)}
      />
      <SectionSeparator />
      <SessionSummarySection usage={usage} />
      <SectionSeparator />
      <SessionTokensSection usage={usage} />
      <SectionSeparator />
      <SessionActivitySection usage={usage} />
    </div>
  );
}

function ContextWindowSection({
  breakdown,
  usage,
  readOnly,
  onCompact,
}: {
  breakdown: ContextBreakdown;
  usage: SessionUsage;
  readOnly: boolean;
  onCompact: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ratioLabel = breakdown.window === null
    ? `${formatTokens(breakdown.used)} tokens`
    : `${formatTokens(breakdown.used)} / ${formatTokens(breakdown.window)} (${share(breakdown.used, breakdown.window)})`;

  return (
    <section className="p-3.5 pb-3">
      <button type="button" aria-expanded={isOpen} onClick={() => setIsOpen((open) => !open)} className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors duration-100 hover:bg-hover">
        <span className="text-sm font-medium text-muted">Context window</span>
        <span className="flex-1" />
        <span className="text-xs text-muted tabular-nums">{ratioLabel}</span>
        <CaretDownIcon size={14} className={cn("shrink-0 text-subtle transition-transform duration-150 ease-out", isOpen && "rotate-180")} />
      </button>

      <SegmentBar breakdown={breakdown} />

      <Collapse open={isOpen}>
        <BreakdownView breakdown={breakdown} usage={usage} />
      </Collapse>

      <footer className="mt-2.5 flex items-center gap-3 text-xs">
        <PressureNotice pressure={breakdown.pressure} />
        <span className="flex-1" />
        <button type="button" disabled={readOnly} onClick={onCompact} className="shrink-0 font-medium text-accent-text underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-40">
          Compact session
        </button>
      </footer>
    </section>
  );
}

function SegmentBar({ breakdown }: { breakdown: ContextBreakdown }) {
  const { slices, used, window } = breakdown;
  const denominator = window ?? used;

  return (
    <div role="img" aria-label={segmentBarLabel(used, window)} className="mt-2 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-active">
      {slices.map((item) => (
        <span key={item.key} className={cn("h-full shrink-0 first:rounded-l-full", resolveSliceColor(item.key))} style={{ width: `${Math.max((item.tokens / denominator) * 100, 0.6)}%` }} />
      ))}
    </div>
  );
}

function BreakdownView({ breakdown, usage }: { breakdown: ContextBreakdown; usage: SessionUsage }) {
  const toolTokens = usage.tools.reduce((acc, t) => acc + t.tokens, 0);
  const toolCalls = usage.tools.reduce((acc, t) => acc + t.calls, 0);
  const subagentTokens = usage.subagents.reduce((acc, a) => acc + a.tokens, 0);

  return (
    <div className="pt-3">
      <ul className="grid gap-1.5">
        {breakdown.slices.map((slice) => (
          <BreakdownSliceRow
            key={slice.key}
            swatchColor={resolveSliceColor(slice.key)}
            label={slice.label}
            amount={`≈${formatTokens(slice.tokens)}`}
            ratio={share(slice.tokens, breakdown.window)}
          />
        ))}
        {breakdown.free !== null && (
          <BreakdownSliceRow
            swatchColor="bg-active"
            label="Free space"
            amount={formatTokens(breakdown.free)}
            ratio={share(breakdown.free, breakdown.window)}
          />
        )}
      </ul>

      {usage.tools.length > 0 && (
        <CollapsibleUsageGroup
          groupTitle="Tool results this session"
          aggregateTokens={`≈${formatTokens(toolTokens)}`}
          invocationCount={`${toolCalls}`}
          items={usage.tools.map((t) => ({ key: t.tool, label: t.tool, value: `≈${formatTokens(t.tokens)}`, aside: `${t.calls}×` }))}
        />
      )}

      {usage.subagents.length > 0 && (
        <CollapsibleUsageGroup
          groupTitle="Subagents"
          subCaption={SUBAGENT_CAPTION}
          aggregateTokens={formatTokens(subagentTokens)}
          invocationCount={`${usage.subagents.length}`}
          items={usage.subagents.map((a) => ({ key: a.itemId, label: a.label, value: formatTokens(a.tokens) }))}
        />
      )}

      <p className="mt-2.5 text-2xs leading-4 text-subtle">{breakdownNote(breakdown.pressure)}</p>
    </div>
  );
}

function BreakdownSliceRow({ swatchColor, label, amount, ratio }: { swatchColor: string; label: string; amount: string; ratio: string }) {
  return (
    <li className="flex items-center gap-2 text-xs">
      <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-[3px]", swatchColor)} />
      <span className="min-w-0 flex-1 truncate text-fg">{label}</span>
      <span className="w-16 shrink-0 text-right text-muted tabular-nums">{amount}</span>
      <span className="w-12 shrink-0 text-right font-medium text-fg tabular-nums">{ratio}</span>
    </li>
  );
}

function GroupItemRow({ item }: { item: { key: string; label: string; value: string; aside?: string } }) {
  return (
    <li key={item.key} className="flex items-center justify-between gap-2 text-xs text-muted">
      <span className="min-w-0 flex-1 truncate font-mono text-2xs" title={item.label}>{item.label}</span>
      <span className="w-16 shrink-0 text-right tabular-nums text-muted">{item.value}</span>
      <span className="w-12 shrink-0 text-right tabular-nums text-subtle">{item.aside ?? ""}</span>
    </li>
  );
}

function CollapsibleUsageGroup({
  groupTitle,
  subCaption,
  aggregateTokens,
  invocationCount,
  items,
}: {
  groupTitle: string;
  subCaption?: string;
  aggregateTokens: string;
  invocationCount: string;
  items: { key: string; label: string; value: string; aside?: string }[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-2.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs transition-colors duration-100 hover:bg-hover">
        <CaretRightIcon size={12} className={cn("shrink-0 text-subtle transition-transform duration-150", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate text-fg">{groupTitle}</span>
        <span className="w-16 shrink-0 text-right text-muted tabular-nums">{aggregateTokens}</span>
        <span className="w-12 shrink-0 text-right text-muted tabular-nums">{invocationCount}</span>
      </button>
      {subCaption && <p className="pl-[18px] text-2xs leading-4 text-subtle">{subCaption}</p>}
      <Collapse open={open}>
        <ul className="mt-1 flex max-h-44 flex-col gap-1 overflow-y-auto pl-[18px]">
          {items.map((row) => (
            <GroupItemRow key={row.key} item={row} />
          ))}
        </ul>
      </Collapse>
    </div>
  );
}

function PressureNotice({ pressure }: { pressure: string }) {
  const note = pressureNote(pressure);
  if (note.tone === "danger") {
    return <span className="font-medium text-danger-text">{note.text}</span>;
  }
  if (note.tone === "warn") {
    return <span className="font-medium text-warn-text">{note.text}</span>;
  }
  return <span className="text-muted">{note.text}</span>;
}

function SectionSeparator() {
  return <hr aria-hidden="true" className="mx-3.5 border-t border-line" />;
}

function SectionHeader({ title, aside }: { title: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <h3 className="text-xs font-semibold text-fg">{title}</h3>
      <span className="flex-1" />
      {aside && <span className="min-w-0 truncate text-xs text-muted">{aside}</span>}
    </div>
  );
}

function SessionSummarySection({ usage }: { usage: SessionUsage }) {
  const costValue = contextCostValue(usage);
  const costContent = costValue === null ? (
    <Tip label={unpricedWhy(usage)}>
      <span className="cursor-default text-fg" tabIndex={0}>Not listed</span>
    </Tip>
  ) : (
    <span className="whitespace-nowrap text-fg tabular-nums" title={costTitle(usage)}>
      {costValue}
    </span>
  );

  return (
    <section className="p-3.5 py-3">
      <SectionHeader title="This session" />
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div className="flex min-w-0 gap-1.5">
          <span className="text-subtle font-normal">Cost</span>
          {costContent}
        </div>
        <div className="flex min-w-0 gap-1.5 tabular-nums">
          <span className="text-subtle font-normal">Lines</span>
          <span className="text-ok-text font-medium">+{usage.lines.added}</span>
          <span className="text-danger-text font-medium">−{usage.lines.removed}</span>
        </div>
        <div className="flex min-w-0 gap-1.5">
          <span className="text-subtle font-normal">Cache hit</span>
          <span className="tabular-nums text-fg">{usage.cacheHit === null ? "none yet" : `${Math.round(usage.cacheHit * 100)}%`}</span>
        </div>
      </div>
    </section>
  );
}

function ModelUsageStatRow({ model, currency }: { model: SessionUsage["models"][number]; currency: string | undefined }) {
  const tokenSum = formatTokens(model.promptTokens + model.outputTokens);
  const costLabel = model.cost === null ? "" : formatCost(model.cost, currency);
  return (
    <li key={model.modelId} className="flex items-center gap-2 text-muted text-xs">
      <span className="min-w-0 flex-1 truncate font-normal">{modelDisplayName(model.modelId)}</span>
      <span className="tabular-nums text-subtle">{model.calls} calls</span>
      <span className="w-14 text-right tabular-nums">{tokenSum}</span>
      <span className="w-14 text-right tabular-nums">{costLabel}</span>
    </li>
  );
}

function SessionTokensSection({ usage }: { usage: SessionUsage }) {
  const modelCountLabel = usage.models.length === 1
    ? modelDisplayName(usage.models[0]?.modelId)
    : usage.models.length > 1
      ? `${usage.models.length} models`
      : null;

  const { rows, note } = contextTokenRows(usage);
  const activeCurrency = usage.currency ?? undefined;

  return (
    <section className="p-3.5 py-3">
      <SectionHeader title="Tokens" aside={modelCountLabel} />
      <dl className="mt-1.5 divide-y divide-line text-xs">
        {rows.map((row) => (
          <TokenMetricLine key={row.id} label={row.label} hint={row.hint} value={row.value} isStrong={row.strong} />
        ))}
      </dl>
      {note && <p className="mt-1.5 text-2xs leading-4 text-subtle">{note}</p>}
      {usage.models.length > 1 && (
        <ul className="mt-2 grid gap-1 text-xs">
          {usage.models.map((m) => (
            <ModelUsageStatRow key={m.modelId} model={m} currency={activeCurrency} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TokenMetricLine({ label, value, hint, isStrong }: { label: string; value: string; hint?: string; isStrong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <dt className={cn(isStrong ? "font-medium text-fg" : "text-muted")}>
        {label}
        {hint && <span className="ml-1.5 text-subtle">{hint}</span>}
      </dt>
      <span className="flex-1" />
      <dd className={cn("tabular-nums", isStrong ? "font-medium text-fg" : "text-fg")}>{value}</dd>
    </div>
  );
}

function CompactionRecordRow({ record }: { record: SessionUsage["compactions"][number] }) {
  const triggerLabel = record.trigger === "auto" ? "Automatic compaction" : "Compaction";
  const outcomeSuffix = record.outcome && record.outcome !== "compacted" ? ` (${record.outcome})` : "";
  const tokenTransition = record.before !== null && record.after !== null ? `${formatTokens(record.before)} → ${formatTokens(record.after)}` : null;

  return (
    <li key={record.itemId} className="flex items-center gap-2 text-muted text-xs">
      <span className="min-w-0 flex-1 truncate">{triggerLabel}{outcomeSuffix}</span>
      {tokenTransition && <span className="tabular-nums">{tokenTransition}</span>}
    </li>
  );
}

function SessionActivitySection({ usage }: { usage: SessionUsage }) {
  return (
    <section className="p-3.5 pt-3 pb-3.5">
      <SectionHeader title="Activity" aside={usage.partial ? LOADED_ONLY : null} />
      <dl className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1.5 text-xs">
        <ActivityPair label="Turns" value={`${usage.turns}`} />
        <ActivityPair label="Model calls" value={`${usage.calls}`} />
        <ActivityPair label="Time working" value={formatSessionDuration(usage.workedMs)} />
        <ActivityPair label="Model time" value={formatSessionDuration(usage.modelMs)} />
        {usage.firstTokenMs !== null && <ActivityPair label="First token" value={formatSessionDuration(usage.firstTokenMs)} />}
        {usage.lines.files > 0 && <ActivityPair label="Files changed" value={`${usage.lines.files}`} />}
      </dl>
      {usage.compactions.length > 0 && (
        <ul className="mt-2 grid gap-1 text-xs">
          {usage.compactions.map((item) => (
            <CompactionRecordRow key={item.itemId} record={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-fg tabular-nums">{value}</dd>
    </div>
  );
}
