import { CaretDownIcon, PauseIcon, PlayIcon, SquareIcon, TargetIcon, XIcon } from "../ui/icons.js";
import { useMemo } from "react";
import { shallowEqual, useApp, useController, useNow } from "../../app/context.js";
import { formatDuration, relativeTime } from "../../model/format.js";
import { goalView, type GoalTone, type GoalView } from "../../model/goal.js";
import { turnsCost } from "../../model/usage.js";
import { goalCostTip, goalCostValue, goalTokensTip, goalTokensValue } from "../../model/usage-labels.js";
import { CloseCard } from "../requests/Requests.js";
import { Tip } from "../ui/overlays.js";
import { Button, cn } from "../ui/primitives.js";

function resolveTonePill(tone: GoalTone): string {
  switch (tone) {
    case "active": return "bg-accent-soft text-accent-text";
    case "paused": return "bg-active text-muted";
    case "done": return "bg-active text-ok-text";
    case "attention": return "bg-warn-soft text-warn-text";
    default: return "bg-active text-subtle";
  }
}

function resolveProgressFill(tone: GoalTone): string {
  switch (tone) {
    case "active": return "bg-accent";
    case "done": return "bg-ok";
    case "attention": return "bg-warn";
    default: return "bg-line-strong";
  }
}

function useGoalPanelModel(sessionId: string) {
  const controller = useController();
  const inputs = useApp((s) => {
    const threadFold = s.threads[sessionId]?.fold;
    return threadFold
      ? { goal: threadFold.meta.goal, seen: threadFold.meta.goalSeen, since: threadFold.meta.goalSince, calls: threadFold.meta.calls, items: threadFold.order.length }
      : null;
  }, shallowEqual);

  const view = useMemo(() => {
    const threadFold = controller.store.get().threads[sessionId]?.fold;
    return inputs && threadFold ? goalView(threadFold) : null;
  }, [inputs, controller, sessionId]);

  const cardKey = `goal:${sessionId}`;
  const isExpanded = useApp((s) => !s.prefs.collapsedCards.includes(cardKey));
  const isHidden = useApp((s) => s.prefs.hiddenCards.includes(cardKey));
  const isClockActive = view?.tone === "active" && view.startedAt !== null;
  const currentTimestamp = useNow(1000, isClockActive);

  return { controller, view, cardKey, isExpanded, isHidden, currentTimestamp };
}

function GoalCollapseTrigger({
  isExpanded,
  onToggle,
  tone,
  label,
  percent,
  objective,
  elapsed,
}: {
  isExpanded: boolean;
  onToggle: () => void;
  tone: GoalTone;
  label: string;
  percent: number;
  objective: string;
  elapsed: number | null;
}) {
  const pillStyle = cn("shrink-0 rounded-md px-1.5 py-px text-2xs font-medium", resolveTonePill(tone));
  const caretRotation = cn("shrink-0 text-subtle transition-transform duration-200", !isExpanded && "-rotate-90");
  const elapsedDisplay = elapsed !== null ? formatDuration(elapsed) || "0s" : null;

  return (
    <button type="button" aria-expanded={isExpanded} onClick={onToggle} className="flex h-10 min-w-0 flex-1 items-center gap-2.5 pl-3.5 text-left">
      <TargetIcon size={15} className="text-subtle shrink-0" />
      <span className="text-sm font-semibold text-fg">Goal</span>
      <span className={pillStyle}>{label}</span>
      <span className="shrink-0 text-xs text-subtle tabular-nums">{Math.round(percent)}%</span>
      {!isExpanded && <span className="min-w-0 truncate text-xs text-muted">{objective}</span>}
      <div className="flex-1" />
      {elapsedDisplay && <span className="shrink-0 text-xs text-subtle tabular-nums">{elapsedDisplay}</span>}
      <CaretDownIcon size={14} className={caretRotation} />
    </button>
  );
}

export function GoalPanel(props: { sessionId: string; running: boolean; readOnly: boolean }) {
  const { controller, view, cardKey, isExpanded, isHidden, currentTimestamp } = useGoalPanelModel(props.sessionId);

  if (!view || isHidden) return null;

  const totalElapsed = view.startedAt === null ? null : Math.max(0, (view.endedAt ?? currentTimestamp) - view.startedAt - view.pausedMs);

  return (
    <section aria-label="Goal" className="enter-up rounded-2xl bg-raised overflow-hidden shadow-card">
      <div className="flex items-center pr-2 transition-colors hover:bg-hover">
        <GoalCollapseTrigger
          isExpanded={isExpanded}
          onToggle={() => controller.setCardOpen(cardKey, !isExpanded)}
          tone={view.tone}
          label={view.label}
          percent={view.percent}
          objective={view.objective}
          elapsed={totalElapsed}
        />
        <CloseCard label="Hide the goal" onClose={() => controller.setCardHidden(cardKey, true)} />
      </div>
      {isExpanded && <GoalCardBody view={view} elapsed={totalElapsed} now={currentTimestamp} controller={controller} {...props} />}
    </section>
  );
}

function GoalProgressIndicator({ percent, tone }: { percent: number; tone: GoalTone }) {
  const rounded = Math.round(percent);
  return (
    <div role="progressbar" aria-label="Goal progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={rounded} className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-active">
      <div className={cn("h-full rounded-full transition-[width] duration-300 ease-out", resolveProgressFill(tone))} style={{ width: `${percent}%` }} />
    </div>
  );
}

function GoalCardBody(props: {
  view: GoalView;
  elapsed: number | null;
  now: number;
  sessionId: string;
  running: boolean;
  readOnly: boolean;
  controller: ReturnType<typeof useController>;
}) {
  const { view, elapsed, now, sessionId, running, readOnly, controller } = props;
  const modelCatalog = useApp((state) => state.models);
  const isTruncated = useApp((s) => s.threads[sessionId]?.truncated ?? false);

  const goalSpend = useMemo(() => {
    const threadFold = controller.store.get().threads[sessionId]?.fold;
    return threadFold ? turnsCost(threadFold, view.turnIds, modelCatalog, isTruncated, view.startedAt) : null;
  }, [view, modelCatalog, isTruncated, controller, sessionId]);

  const isBusy = useApp((s) => Boolean(s.busy[`goal:${sessionId}`]));
  const missingHistory = goalSpend?.partial ?? false;
  const lastProgressTimestamp = view.lastProgressAt ?? view.endedAt;

  const handleCreateNewGoal = () => {
    const existingDraft = document.querySelector<HTMLTextAreaElement>("textarea")?.value.trim() ?? "";
    const promptInjection = !existingDraft ? "/goal " : /^\/goal\b/i.test(existingDraft) ? existingDraft : `/goal ${existingDraft}`;
    controller.prefillComposer(sessionId, promptInjection);
    requestAnimationFrame(() => {
      const activeTextarea = document.querySelector<HTMLTextAreaElement>("textarea[aria-autocomplete], textarea");
      activeTextarea?.focus();
      activeTextarea?.setSelectionRange(activeTextarea.value.length, activeTextarea.value.length);
    });
  };

  return (
    <div className="px-3.5 pb-3.5">
      <h4 className="line-clamp-3 text-sm text-pretty font-normal text-fg [overflow-wrap:anywhere]" title={view.objective}>
        {view.objective}
      </h4>

      <GoalProgressIndicator percent={view.percent} tone={view.tone} />

      <dl className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-5">
        <GoalMetricItem label={view.tone === "active" ? "Running for" : "Ran for"} value={elapsed === null ? "Not known" : formatDuration(elapsed) || "0s"} />
        <GoalMetricItem label="Turns" value={String(view.turns)} />
        <Tip label={goalTokensTip(missingHistory, view.tokensUsed)}>
          <div tabIndex={0} className="cursor-default min-w-0">
            <GoalMetricItem label="Tokens" value={goalTokensValue(view.tokens, view.tokenBudget, missingHistory)} />
          </div>
        </Tip>
        <Tip label={goalCostTip(goalSpend)}>
          <div tabIndex={0} className="cursor-default min-w-0">
            <GoalMetricItem label="Cost" value={goalCostValue(goalSpend)} />
          </div>
        </Tip>
        <GoalMetricItem label="Last update" value={lastProgressTimestamp ? relativeTime(new Date(lastProgressTimestamp).toISOString(), now) : "None yet"} />
      </dl>

      {(view.tone === "active" || view.tone === "paused" || view.tone === "attention") && (view.currentWork || view.nextWork) && (
        <dl className="mt-2.5 grid gap-1 text-xs">
          {view.currentWork && <GoalWorkItem label="Now" text={view.currentWork} />}
          {view.nextWork && <GoalWorkItem label="Next" text={view.nextWork} />}
        </dl>
      )}

      {!readOnly && (
        <GoalActionRow
          sessionId={sessionId}
          tone={view.tone}
          running={running}
          busy={isBusy}
          onNewGoal={handleCreateNewGoal}
          onPause={() => void controller.goalAction(sessionId, "pause")}
          onStopTurn={() => void controller.stop(sessionId)}
          onResume={() => void controller.continueGoal(sessionId, view.objective, view.status)}
          onClear={() => void controller.goalAction(sessionId, "clear")}
        />
      )}
    </div>
  );
}

function GoalActionRow({
  sessionId: _sessionId,
  tone,
  running,
  busy,
  onNewGoal,
  onPause,
  onStopTurn,
  onResume,
  onClear,
}: {
  sessionId: string;
  tone: GoalTone;
  running: boolean;
  busy: boolean;
  onNewGoal: () => void;
  onPause: () => void;
  onStopTurn: () => void;
  onResume: () => void;
  onClear: () => void;
}) {
  return (
    <nav aria-label="Goal actions" className="mt-3 flex flex-wrap items-center gap-2">
      {tone === "active" && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onPause}>
          <PauseIcon size={13} /> Pause goal
        </Button>
      )}
      {tone === "active" && running && (
        <Button size="sm" variant="ghost" onClick={onStopTurn}>
          <SquareIcon size={12} /> Stop turn
        </Button>
      )}
      {(tone === "paused" || tone === "attention") && !running && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onResume}>
          <PlayIcon size={13} /> {tone === "paused" ? "Resume goal" : "Keep going"}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onNewGoal}>
        {tone === "active" ? "Change goal" : "New goal"}
      </Button>
      {tone !== "done" && tone !== "ended" && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClear}>
          <XIcon size={13} /> Clear
        </Button>
      )}
    </nav>
  );
}

function GoalMetricItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-subtle font-normal">{label}</dt>
      <dd className="truncate text-fg tabular-nums">{value}</dd>
    </div>
  );
}

function GoalWorkItem({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex items-start gap-2">
      <dt className="w-9 shrink-0 text-subtle font-normal">{label}</dt>
      <dd className="min-w-0 text-muted [overflow-wrap:anywhere]">{text}</dd>
    </div>
  );
}
