import { DatabaseIcon, GaugeIcon } from "../ui/icons.js";
import { Popover } from "radix-ui";
import { useMemo, useState, type ReactNode } from "react";
import { useApp } from "../../app/context.js";
import { formatDuration, formatExactTokens, formatTokensPerSecond } from "../../model/format.js";
import { sessionTelemetry, timePillLabel, usagePillLabel, type SessionTelemetry, type TelemetryModelUsage } from "../../model/usage.js";
import { SPEED_TIP } from "../../model/usage-labels.js";
import { Tip, FLOATING } from "../ui/overlays.js";

type ActiveTelemetryModal = "time" | "usage" | null;

const FLYOUT_SURFACE_STYLE = "pop z-[var(--z-dropdown)] max-h-[var(--radix-popover-content-available-height)] w-[340px] max-w-[calc(100dvw-24px)] overflow-y-auto rounded-xl bg-raised text-fg shadow-pop outline-none";
const FLYOUT_OFFSET_PX = 6;
const PILL_TRIGGER_STYLE = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-2xs text-subtle tabular-nums transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg";

function useSessionTelemetrySnapshot(sessionId: string): SessionTelemetry | null {
  const isEnabled = useApp((s) => s.prefs.showTelemetry);
  const threadFold = useApp((s) => s.threads[sessionId]?.fold ?? null);
  const isTruncated = useApp((s) => s.threads[sessionId]?.truncated ?? false);

  const metrics = useMemo(() => {
    return threadFold ? sessionTelemetry(threadFold, isTruncated) : null;
  }, [threadFold, isTruncated]);

  if (!isEnabled || !metrics || !threadFold) {
    return null;
  }

  const hasNoActivity = metrics.turns === 0 && metrics.steps === 0 && metrics.totalTokens === 0 && !threadFold.activeTurnId;
  return hasNoActivity ? null : metrics;
}

export function TelemetryPills(props: { sessionId: string }) {
  const telemetry = useSessionTelemetrySnapshot(props.sessionId);
  const [modal, setModal] = useState<ActiveTelemetryModal>(null);

  if (!telemetry) return null;

  return (
    <nav aria-label="Session telemetry" className="flex items-center justify-center gap-1.5">
      <TelemetryTriggerPill
        icon={<GaugeIcon size={12} />}
        isOpen={modal === "time"}
        onToggleOpen={(open) => setModal(open ? "time" : null)}
        label={timePillLabel(telemetry)}
        tip="Timing of this session's model calls"
        ariaName="Session timing"
      >
        <TimingDetailsSection telemetry={telemetry} />
      </TelemetryTriggerPill>

      <TelemetryTriggerPill
        icon={<DatabaseIcon size={12} />}
        isOpen={modal === "usage"}
        onToggleOpen={(open) => setModal(open ? "usage" : null)}
        label={usagePillLabel(telemetry)}
        tip="Token usage of this session"
        ariaName="Session token usage"
      >
        <UsageDetailsSection telemetry={telemetry} />
      </TelemetryTriggerPill>
    </nav>
  );
}

function PillButton({ icon, label, tip, ariaName }: { icon: ReactNode; label: string; tip: string; ariaName: string }) {
  return (
    <Tip label={tip}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={ariaName} className={PILL_TRIGGER_STYLE}>
          <span className="shrink-0">{icon}</span>
          {label}
        </button>
      </Popover.Trigger>
    </Tip>
  );
}

function PillFlyout({ children }: { children: ReactNode }) {
  return (
    <Popover.Portal>
      <Popover.Content side="top" align="center" sideOffset={FLYOUT_OFFSET_PX} className={FLYOUT_SURFACE_STYLE} {...FLOATING}>
        {children}
      </Popover.Content>
    </Popover.Portal>
  );
}

function TelemetryTriggerPill({
  icon,
  isOpen,
  onToggleOpen,
  label,
  tip,
  ariaName,
  children,
}: {
  icon: ReactNode;
  isOpen: boolean;
  onToggleOpen: (open: boolean) => void;
  label: string;
  tip: string;
  ariaName: string;
  children: ReactNode;
}) {
  return (
    <Popover.Root open={isOpen} onOpenChange={onToggleOpen}>
      <PillButton icon={icon} label={label} tip={tip} ariaName={ariaName} />
      <PillFlyout>{children}</PillFlyout>
    </Popover.Root>
  );
}

function resolveTimingSubtitle(t: SessionTelemetry): string {
  if (t.partial) {
    return "Partial history: timing, turns and steps cover the loaded calls only.";
  }
  return t.timedCalls === t.steps ? "Every model call reported how long it took." : "Some calls did not report how long they took.";
}

function TimingDetailsSection({ telemetry }: { telemetry: SessionTelemetry }) {
  const durationText = telemetry.timedCalls > 0 ? formatDuration(telemetry.durationMs) : "—";
  const speedText = telemetry.tokensPerSecond === null ? "—" : formatTokensPerSecond(telemetry.tokensPerSecond);

  return (
    <section className="grid gap-3 p-3.5">
      <header>
        <h3 className="text-sm font-semibold text-fg">
          {durationText} <span className="font-normal text-subtle">of model time</span>
        </h3>
        <p className="mt-0.5 text-xs text-muted">{resolveTimingSubtitle(telemetry)}</p>
      </header>
      <dl className="grid gap-1 text-xs">
        <TelemetryDataRow label="Steps" value={`${telemetry.steps}`} />
        <TelemetryDataRow label="Request average" tip={SPEED_TIP} value={speedText} />
        <TelemetryDataRow label="Timed" value={`${telemetry.timedCalls} of ${telemetry.steps} calls timed`} />
      </dl>
      <ModelUsageSummary models={telemetry.models} />
    </section>
  );
}

function resolveUsageSubtitle(t: SessionTelemetry): string {
  if (!t.partial) {
    return "Exact counts over every model call in this thread.";
  }
  return t.totalsComplete
    ? "Session token totals are complete. Cache, reasoning and model details cover loaded calls only."
    : "Partial history: token counts and details cover loaded calls only.";
}

function UsageDetailsSection({ telemetry }: { telemetry: SessionTelemetry }) {
  const isPartial = telemetry.partial;
  const suffix = telemetry.totalsComplete ? "" : "+";
  const hitRatio = telemetry.cacheHitPct === null ? "—" : `${telemetry.cacheHitPct}%`;

  return (
    <section className="grid gap-3 p-3.5">
      <header>
        <h3 className="text-sm font-semibold text-fg">
          {formatExactTokens(telemetry.totalTokens)}{suffix} <span className="font-normal text-subtle">tokens</span>
        </h3>
        <p className="mt-0.5 text-xs text-muted">{resolveUsageSubtitle(telemetry)}</p>
      </header>
      <dl className="grid gap-1 text-xs">
        <TelemetryDataRow label="Output" value={formatExactTokens(telemetry.outputTokens)} />
        {telemetry.reasoningTokens > 0 && (
          <aside className="pl-2 text-2xs text-subtle tabular-nums">
            {isPartial ? "loaded calls include " : "includes "}{formatExactTokens(telemetry.reasoningTokens)} reasoning
          </aside>
        )}
        <TelemetryDataRow label={isPartial ? "Loaded uncached input" : "Uncached input"} value={formatExactTokens(telemetry.uncachedTokens)} />
        <TelemetryDataRow label={isPartial ? "Loaded cached input" : "Cached input"} value={formatExactTokens(telemetry.cachedTokens)} />
        {telemetry.cacheWriteTokens > 0 && (
          <TelemetryDataRow label={isPartial ? "Loaded cache write" : "Cache write"} value={formatExactTokens(telemetry.cacheWriteTokens)} />
        )}
        <TelemetryDataRow label={isPartial ? "Loaded cache hit" : "Cache hit"} value={hitRatio} />
      </dl>
      <ModelUsageSummary models={telemetry.models} />
    </section>
  );
}

function ModelUsageSummary({ models }: { models: readonly TelemetryModelUsage[] }) {
  if (models.length === 0) return null;

  return (
    <div className="grid gap-1.5 border-t border-line pt-3">
      {models.map((m) => (
        <div key={m.modelId} className="flex items-baseline justify-between gap-3 text-xs">
          <span className="min-w-0 truncate text-fg">{m.name}</span>
          <span className="shrink-0 text-muted tabular-nums">{m.calls === 1 ? "1 call" : `${m.calls} calls`}</span>
          <span className="w-20 shrink-0 text-right text-muted tabular-nums">{formatExactTokens(m.outputTokens)} out</span>
        </div>
      ))}
    </div>
  );
}

function TelemetryDataRow({ label, value, tip }: { label: string; value: string; tip?: string }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-2.5">
      <dt className="text-muted">
        {tip ? (
          <Tip label={tip}>
            <span tabIndex={0} className="cursor-default">
              {label}
            </span>
          </Tip>
        ) : (
          label
        )}
      </dt>
      <dd className="tabular-nums text-fg">{value}</dd>
    </div>
  );
}
