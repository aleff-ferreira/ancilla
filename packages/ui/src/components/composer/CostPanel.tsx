import { Popover } from "radix-ui";
import { shallowEqual, useApp } from "../../app/context.js";
import { modelDisplayName } from "../../model/format.js";
import { formatCost, priceOf } from "../../model/pricing.js";
import { sessionUsage } from "../../model/usage.js";
import { costNotes, costRows, costTip, modelRateCaption, subagentLine, usageCostLabel, type TokenRow } from "../../model/usage-labels.js";
import { Tip, FLOATING } from "../ui/overlays.js";

/** What this thread would have cost on API billing, beside the context meter. */
export function CostMeter(props: { sessionId: string }) {
  const total = useApp((s) => {
    const thread = s.threads[props.sessionId];
    if (!thread?.fold) {
      return null;
    }
    const usage = sessionUsage(thread.fold, s.models, thread.truncated);
    const label = usageCostLabel(usage);
    return label === null || !usage.cost || usage.cost <= 0 ? null : { label, tip: costTip(usage) };
  }, shallowEqual);
  if (!total) {
    return null;
  }
  return (
    <Popover.Root>
      <Tip label={total.tip}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={`Thread cost ${total.label}`}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-1.5 text-2xs text-subtle tabular-nums transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg"
          >
            {total.label}
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={6}
          {...FLOATING}
          className="pop z-[var(--z-dropdown)] max-h-[var(--radix-popover-content-available-height)] w-[340px] max-w-[calc(100dvw-24px)] overflow-y-auto rounded-xl bg-raised text-fg shadow-pop outline-none"
        >
          <CostPanel sessionId={props.sessionId} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Mounted only while the popover is open, so a streaming thread does not recompute it. */
function CostPanel(props: { sessionId: string }) {
  const truncated = useApp((s) => s.threads[props.sessionId]?.truncated ?? false);
  const usage = useApp((s) => {
    const fold = s.threads[props.sessionId]?.fold;
    return fold ? sessionUsage(fold, s.models, truncated) : null;
  });
  const prices = useApp((s) => s.models);
  if (!usage) {
    return null;
  }
  const currency = usage.currency ?? undefined;
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <div>
        <p className="text-sm font-semibold text-fg">
          {usageCostLabel(usage) ?? formatCost(0, currency)} <span className="font-normal text-subtle">at API rates</span>
        </p>
        {costNotes(usage).map((note) => (
          <p key={note} className="mt-0.5 text-xs text-muted">
            {note}
          </p>
        ))}
      </div>

      <dl className="flex flex-col gap-1 text-xs">
        {costRows(usage).map((row) => (
          <Row key={row.id} {...row} />
        ))}
      </dl>
      {usage.excludesSubagents ? <p className="text-xs text-muted">{subagentLine(usage.subagentTokens)}</p> : null}

      {usage.models.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-t border-line pt-3">
          {usage.models.map((model) => {
            const option = prices.find((m) => m.modelId === model.modelId);
            const price = priceOf(model.modelId, prices);
            return (
              <div key={model.modelId} className="flex items-baseline justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <p className="truncate text-fg">
                    {modelDisplayName(model.modelId)}
                    {option?.contributor || /contributor/i.test(model.modelId) ? (
                      <span className="ml-1.5 rounded bg-active px-1 py-px align-middle text-2xs font-medium text-muted">contributor</span>
                    ) : null}
                  </p>
                  <p className="text-2xs text-subtle tabular-nums">{modelRateCaption(model.modelId, price)}</p>
                </div>
                <span className="shrink-0 tabular-nums text-muted">{model.cost === null ? "—" : formatCost(model.cost, currency)}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Row(props: TokenRow) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={props.muted ? "text-subtle" : "text-muted"}>{props.label}</dt>
      <dd className="tabular-nums text-fg">{props.value}</dd>
    </div>
  );
}
