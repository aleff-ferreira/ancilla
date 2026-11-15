import { Popover } from "radix-ui";
import { useApp } from "../../app/context.js";
import { modelDisplayName } from "../../model/format.js";
import { formatCost, priceOf } from "../../model/pricing.js";
import { sessionUsage, type ModelUsage } from "../../model/usage.js";
import { costNotes, costRows, costTip, modelRateCaption, subagentLine, usageCostLabel, type TokenRow } from "../../model/usage-labels.js";
import type { ModelOption } from "../../types.js";
import { Tip, FLOATING } from "../ui/overlays.js";

const POP_OFFSET_PX = 6;
const POP_SURFACE_STYLE = "pop z-[var(--z-dropdown)] max-h-[var(--radix-popover-content-available-height)] w-[340px] max-w-[calc(100dvw-24px)] overflow-y-auto rounded-xl bg-raised text-fg shadow-pop outline-none";
const TRIGGER_CLASS = "inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-1.5 text-2xs text-subtle tabular-nums transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg";

function useThreadCostSnapshot(sessionId: string) {
  return useApp(
    (state) => {
      const activeSession = state.threads[sessionId];
      if (!activeSession?.fold) return null;
      const metrics = sessionUsage(activeSession.fold, state.models, activeSession.truncated);
      const caption = usageCostLabel(metrics);
      return caption !== null && metrics.cost && metrics.cost > 0 ? { caption, hint: costTip(metrics) } : null;
    },
    (prev, next) => prev?.caption === next?.caption && prev?.hint === next?.hint,
  );
}

function CostTriggerButton({ caption, hint }: { caption: string; hint: string }) {
  return (
    <Tip label={hint}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={`Thread cost ${caption}`} className={TRIGGER_CLASS}>
          {caption}
        </button>
      </Popover.Trigger>
    </Tip>
  );
}

function CostPopoverPortal({ sessionId }: { sessionId: string }) {
  return (
    <Popover.Portal>
      <Popover.Content side="top" align="end" sideOffset={POP_OFFSET_PX} className={POP_SURFACE_STYLE} {...FLOATING}>
        <CostPanel sessionId={sessionId} />
      </Popover.Content>
    </Popover.Portal>
  );
}

export function CostMeter({ sessionId }: { sessionId: string }) {
  const cost = useThreadCostSnapshot(sessionId);
  if (!cost) return null;

  return (
    <Popover.Root>
      <CostTriggerButton caption={cost.caption} hint={cost.hint} />
      <CostPopoverPortal sessionId={sessionId} />
    </Popover.Root>
  );
}

function CostPanel({ sessionId }: { sessionId: string }) {
  const isTruncated = useApp((s) => s.threads[sessionId]?.truncated ?? false);
  const catalog = useApp((s) => s.models);
  const threadUsage = useApp((state) => {
    const threadFold = state.threads[sessionId]?.fold;
    return threadFold ? sessionUsage(threadFold, state.models, isTruncated) : null;
  });

  if (!threadUsage) return null;

  const activeCurrency = threadUsage.currency ?? undefined;
  const headline = usageCostLabel(threadUsage) ?? formatCost(0, activeCurrency);
  const notes = costNotes(threadUsage);
  const rows = costRows(threadUsage);
  const modelEntries = threadUsage.models;

  return (
    <section className="grid gap-3 p-3.5">
      <header>
        <h3 className="text-sm font-semibold text-fg">
          {headline} <span className="font-normal text-subtle">at API rates</span>
        </h3>
        {notes.map((msg) => (
          <p key={msg} className="mt-0.5 text-xs text-muted">{msg}</p>
        ))}
      </header>

      <dl className="grid gap-1 text-xs">
        {rows.map((r) => (
          <CostItemRow key={r.id} row={r} />
        ))}
      </dl>

      {threadUsage.excludesSubagents && (
        <p className="text-xs text-muted">{subagentLine(threadUsage.subagentTokens)}</p>
      )}

      {modelEntries.length > 0 && (
        <div className="grid gap-1.5 border-t border-line pt-3">
          {modelEntries.map((m) => (
            <ModelUsageItem key={m.modelId} item={m} catalog={catalog} currency={activeCurrency} />
          ))}
        </div>
      )}
    </section>
  );
}

function ModelUsageItem({
  item,
  catalog,
  currency,
}: {
  item: ModelUsage;
  catalog: readonly ModelOption[];
  currency: string | undefined;
}) {
  const opt = catalog.find((cand) => cand.modelId === item.modelId);
  const rate = priceOf(item.modelId, catalog);
  const isContrib = Boolean(opt?.contributor || /contributor/i.test(item.modelId));
  const costText = item.cost === null ? "—" : formatCost(item.cost, currency);

  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <div className="min-w-0">
        <p className="truncate text-fg">
          {modelDisplayName(item.modelId)}
          {isContrib && (
            <span className="ml-1.5 inline-block rounded bg-active px-1 py-0.5 text-2xs font-medium text-muted">
              contributor
            </span>
          )}
        </p>
        <p className="text-2xs text-subtle tabular-nums">{modelRateCaption(item.modelId, rate)}</p>
      </div>
      <span className="shrink-0 tabular-nums text-muted">{costText}</span>
    </div>
  );
}

function CostItemRow({ row }: { row: TokenRow }) {
  const tone = row.muted ? "text-subtle" : "text-muted";
  return (
    <div className="flex items-baseline justify-between gap-2.5">
      <dt className={tone}>{row.label}</dt>
      <dd className="tabular-nums text-fg">{row.value}</dd>
    </div>
  );
}
