import { forwardRef, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { ArrowCounterClockwiseIcon, CaretRightIcon, ChatCircleDotsIcon, CheckCircleIcon, CircleDashedIcon, ClockCounterClockwiseIcon, EyeIcon, HourglassIcon, MinusCircleIcon, QuestionIcon, ShieldWarningIcon, SkipForwardIcon, StopCircleIcon, WarningCircleIcon } from "../ui/icons.js";
import { canStopAgent, durationText, type AgentState, type AgentVM, type RunNeedVM, type RunVM } from "../../model/crew.js";
import { Button, Spinner, cn } from "../ui/primitives.js";
import { Peek } from "./Peek.js";
import { Sigil } from "./Sigil.js";
import { RESEARCH_OWN } from "./cardCopy.js";
import { isTall, rowLabel, subline, timeText, tokensText, type Subline } from "./panel.js";

export const ROSTER_COLUMNS = "grid-cols-[16px_8px_18px_8px_minmax(0,1fr)_12px_56px_10px_56px_12px_44px]";

export type RowAction = "retry" | "skip" | "stop" | "review" | "inspect";

export interface RowConfirm {
  id: string;
  kind: "skip" | "stop";
}

export interface RosterRowProps {
  style?: CSSProperties;
  onConfirm(confirm: RowConfirm | null): void;
  onAction(agent: AgentVM, action: RowAction): void;
  onInspect(id: string): void;
  onFocus(id: string): void;
  peek?: boolean;
  confirm: RowConfirm | null;
  readOnly: boolean;
  stale: boolean;
  finale: boolean;
  focused: boolean;
  run: RunVM | null;
  agent: AgentVM;
}

interface GlyphRenderDescriptor {
  colorModifier: string;
  glyphElement: ReactNode;
}

function PlannedDotSymbol() {
  return <span className="size-[11px] rounded-full border-[1.25px] border-dashed border-line-strong" />;
}

function ScheduledDotSymbol() {
  return <span className="size-[11px] rounded-full shadow-[inset_0_0_0_1.5px_var(--border-strong)]" />;
}

function resolveGlyphDescriptor(
  state: AgentState,
  pending: AgentVM["pending"],
  staleFeed: boolean,
  skippedBy: AgentVM["skippedBy"],
  needKind: "approval" | "input" | null | undefined,
): GlyphRenderDescriptor {
  const isActivelyWaitingOrRunning =
    state === "working" ||
    state === "finishing" ||
    state === "no-update" ||
    state === "waiting-on-you" ||
    state === "scheduled";

  if (staleFeed && isActivelyWaitingOrRunning) {
    return { colorModifier: "text-subtle", glyphElement: <ClockCounterClockwiseIcon size={14} /> };
  }
  if (pending === "retry") {
    return { colorModifier: "text-accent-text", glyphElement: <ArrowCounterClockwiseIcon size={14} /> };
  }
  if (pending === "stop") {
    return { colorModifier: "text-accent-text", glyphElement: <Spinner size={11} /> };
  }

  switch (state) {
    case "done":
      return { colorModifier: "text-ok", glyphElement: <CheckCircleIcon size={14} /> };
    case "failed":
      return { colorModifier: "text-danger", glyphElement: <WarningCircleIcon size={14} /> };
    case "waiting-on-you": {
      const isInput = needKind === "input";
      return {
        colorModifier: isInput ? "text-status-input" : "text-warn",
        glyphElement: isInput ? <ChatCircleDotsIcon size={14} /> : <ShieldWarningIcon size={14} />,
      };
    }
    case "no-update":
      return { colorModifier: "text-subtle", glyphElement: <CircleDashedIcon size={14} /> };
    case "working":
    case "finishing":
      return { colorModifier: "text-accent-text", glyphElement: <Spinner size={11} /> };
    case "planned":
      return { colorModifier: "", glyphElement: <PlannedDotSymbol /> };
    case "scheduled":
      return { colorModifier: "", glyphElement: <ScheduledDotSymbol /> };
    case "skipped":
      return {
        colorModifier: "text-subtle",
        glyphElement: skippedBy === "run" ? <StopCircleIcon size={14} /> : <MinusCircleIcon size={14} />,
      };
    case "unknown":
      return { colorModifier: "text-subtle", glyphElement: <QuestionIcon size={14} /> };
  }
}

export function RowGlyph(props: {
  className?: string;
  needKind?: "approval" | "input" | null;
  skippedBy?: AgentVM["skippedBy"];
  stale?: boolean;
  pending?: AgentVM["pending"];
  state: AgentState;
}) {
  const { className, needKind, skippedBy, stale = false, pending, state } = props;
  const descriptor = resolveGlyphDescriptor(state, pending ?? null, stale, skippedBy ?? null, needKind);
  const wrapperStyle = cn("flex size-4 shrink-0 items-center justify-center", descriptor.colorModifier, className);

  return <span className={wrapperStyle}>{descriptor.glyphElement}</span>;
}

export function AgentName(props: { className?: string; agent: Pick<AgentVM, "display" | "kind"> }) {
  const { className, agent } = props;
  const fontStyle = agent.kind === "task" ? "font-mono text-xs" : "text-sm leading-[18px] font-medium";
  const nameWrapper = cn("truncate", fontStyle, className);

  return (
    <span className={nameWrapper}>
      {agent.display.prefix ? <span className="text-subtle">{agent.display.prefix}</span> : null}
      {agent.display.short}
    </span>
  );
}

function resolveShareBarFillClass(agentState: AgentState, isFinale: boolean): string {
  if (agentState === "failed") {
    return "bg-danger";
  }
  if (agentState === "no-update") {
    return "bg-[repeating-linear-gradient(135deg,var(--accent)_0_2px,color-mix(in_oklab,var(--accent)_30%,var(--bg-raised))_2px_4px)]";
  }
  if (agentState === "waiting-on-you") {
    return "bg-warn";
  }
  if (agentState === "working" || agentState === "finishing") {
    return "bg-accent";
  }
  if (isFinale && agentState === "done") {
    return "bg-[var(--lane-done)]";
  }
  return "bg-[var(--bar-fill)]";
}

export function ShareBar(props: { className?: string; finale: boolean; agent: AgentVM }) {
  const { className, finale, agent } = props;
  if (agent.state === "planned" || agent.state === "scheduled") {
    return <span className={cn("block h-1.5", className)} aria-hidden="true" />;
  }

  const fractionRatio = agent.shareOfLongest;
  const fillToneClass = resolveShareBarFillClass(agent.state, finale);
  const containerClasses = cn("relative block h-1.5 overflow-hidden rounded-full bg-active", className);

  return (
    <span className={containerClasses} aria-hidden="true">
      {fractionRatio !== null ? (
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-[var(--dur-fill)]", fillToneClass)}
          style={{ width: `${Math.min(100, Math.round(fractionRatio * 100))}%` }}
        />
      ) : null}
      {fractionRatio !== null && fractionRatio > 1 ? (
        <span className="absolute inset-0 rounded-full bg-[repeating-linear-gradient(135deg,var(--hatch)_0_2px,transparent_2px_4px)]" />
      ) : null}
    </span>
  );
}

const SUBLINE_TONE_MAP: Readonly<Record<Subline["tone"], string>> = Object.freeze({
  fail: "text-danger-text",
  need: "text-warn-text",
  work: "text-accent-text",
  mute: "text-muted",
});

function SublineNarrativeBody({ sublineDetail }: { sublineDetail: Subline }) {
  const toneClass = SUBLINE_TONE_MAP[sublineDetail.tone];

  return (
    <>
      <span className={cn("font-medium", toneClass)}>{sublineDetail.word}</span>
      {sublineDetail.tag ? (
        <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-2xs font-medium text-muted shadow-[inset_0_0_0_1px_var(--border)] tabular-nums">
          {sublineDetail.word === "Running" ? <HourglassIcon size={11} /> : <CircleDashedIcon size={11} />}
          {sublineDetail.tag}
        </span>
      ) : null}
      {sublineDetail.rest.map((segmentText, segmentIndex) => (
        <span key={segmentIndex} className="contents">
          <span className="text-subtle">·</span>
          <span className={cn("truncate", sublineDetail.mono && segmentIndex === sublineDetail.rest.length - 1 && "font-mono text-[11.5px]")}>
            {segmentText}
          </span>
        </span>
      ))}
    </>
  );
}

function ConfirmPromptPlate(props: {
  agentName: string;
  isSkipAction: boolean;
  onExecute(): void;
  onDismiss(): void;
}) {
  const { agentName, isSkipAction, onExecute, onDismiss } = props;
  const promptMessage = isSkipAction
    ? `Skip ${agentName}? The run continues without it.`
    : `Stop ${agentName}?`;

  return (
    <span
      className="absolute right-3 z-[1] inline-flex items-center gap-1.5 rounded-md bg-raised p-px pl-2 text-xs text-fg shadow-btn"
      role="group"
      aria-label={isSkipAction ? "Confirm skip" : "Confirm stop"}
    >
      <span className="whitespace-nowrap">{promptMessage}</span>
      <Button size="sm" variant="secondary" className="h-6 px-2 text-xs" onClick={onExecute}>
        {isSkipAction ? "Skip" : "Stop"}
      </Button>
      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onDismiss}>
        Keep
      </Button>
    </span>
  );
}

function ActionControlsPlate(props: {
  agent: AgentVM;
  readOnly: boolean;
  confirm: RowConfirm | null;
  onAction: RosterRowProps["onAction"];
  onConfirm: RosterRowProps["onConfirm"];
  onInspect(): void;
}) {
  const { agent, readOnly, confirm, onAction, onConfirm, onInspect } = props;

  if (confirm && confirm.id === agent.id) {
    const isSkipKind = confirm.kind === "skip";
    return (
      <ConfirmPromptPlate
        agentName={agent.name}
        isSkipAction={isSkipKind}
        onExecute={() => {
          onConfirm(null);
          onAction(agent, isSkipKind ? "skip" : "stop");
        }}
        onDismiss={() => onConfirm(null)}
      />
    );
  }

  const actionControls: ReactNode[] = [];
  const buttonStyle = "h-6 gap-1 px-2 text-xs";
  const canPerformCommands = !readOnly && agent.pending === null && agent.kind !== "research";

  if (canPerformCommands) {
    const isFailedWorkflow = agent.kind === "workflow" && agent.state === "failed";
    const isAwaitingAction = agent.state === "waiting-on-you";

    if (isFailedWorkflow) {
      actionControls.push(
        <Button key="retry" size="sm" variant="ghost" className={buttonStyle} onClick={() => onAction(agent, "retry")}>
          <ArrowCounterClockwiseIcon size={12} />Retry
        </Button>,
        <Button key="skip" size="sm" variant="ghost" className={buttonStyle} onClick={() => onConfirm({ kind: "skip", id: agent.id })}>
          <SkipForwardIcon size={12} />Skip
        </Button>,
      );
    } else if (isAwaitingAction) {
      const isInputQuery = agent.needs?.kind === "input";
      actionControls.push(
        <Button key="review" size="sm" variant="secondary" className={buttonStyle} onClick={() => onAction(agent, "review")}>
          {isInputQuery ? "Answer" : "Review"}
        </Button>,
      );
    } else if (canStopAgent(agent) && (agent.state === "working" || agent.state === "finishing" || agent.state === "no-update" || agent.state === "scheduled")) {
      actionControls.push(
        <Button key="stop" size="sm" variant="ghost" className={buttonStyle} onClick={() => onConfirm({ kind: "stop", id: agent.id })}>
          <StopCircleIcon size={12} />Stop
        </Button>,
      );
    }
  }

  const isLiveOrStalled =
    agent.state === "working" ||
    agent.state === "finishing" ||
    agent.state === "no-update" ||
    agent.state === "scheduled";

  if (actionControls.length === 0 || isLiveOrStalled) {
    actionControls.push(
      <Button key="inspect" size="sm" variant="ghost" className={buttonStyle} onClick={onInspect}>
        <EyeIcon size={12} />Inspect
      </Button>,
    );
  }

  const plateClasses = "absolute right-3 z-[1] inline-flex items-center gap-0.5 rounded-md bg-raised p-px shadow-btn";
  const researchTooltip = agent.kind === "research" ? RESEARCH_OWN : undefined;

  return (
    <span className={plateClasses} title={researchTooltip}>
      {actionControls}
    </span>
  );
}

export const RosterRow = forwardRef<HTMLDivElement, RosterRowProps>(function RosterRow(props, ref) {
  const {
    agent,
    run,
    focused,
    finale,
    stale,
    readOnly,
    confirm,
    peek,
    onFocus,
    onInspect,
    onAction,
    onConfirm,
    style,
  } = props;

  const isExpandedRow = isTall(agent);
  const secondaryDetail = isExpandedRow ? subline(agent, run) : null;
  const tokenFormatted = tokensText(agent);
  const durationFormatted = timeText(agent);
  const isTimeDimmed = durationFormatted === "—" || (agent.durationMs === null && agent.state !== "done");

  const isDirectInteractiveTarget = (evt: MouseEvent<HTMLElement>) =>
    !(evt.target as HTMLElement).closest("button, .crew-peek");

  const focusIndicatorCls = focused
    ? "bg-active before:absolute before:top-1 before:bottom-1 before:left-0 before:w-0.5 before:rounded-sm before:bg-focus before:content-['']"
    : "hover:bg-hover";

  const heightCls = isExpandedRow ? "min-h-11 pt-[3px] pb-1" : "min-h-8";
  const actionsOffsetCls = isExpandedRow && focused ? "[&>.rowacts]:top-[3px]" : "";

  return (
    <div
      role="row"
      id={`crew-row-${agent.id}`}
      data-agent={agent.id}
      ref={ref}
      tabIndex={focused ? 0 : -1}
      aria-selected={focused}
      aria-label={rowLabel(agent, run)}
      onFocus={() => onFocus(agent.id)}
      onClick={(clickEvt) => {
        if (!isDirectInteractiveTarget(clickEvt)) return;
        onFocus(agent.id);
        onInspect(agent.id);
      }}
      onDoubleClick={(doubleClickEvt) => {
        if (isDirectInteractiveTarget(doubleClickEvt)) {
          onInspect(agent.id);
        }
      }}
      style={style}
      className={cn(
        "relative grid items-center px-4 outline-none",
        ROSTER_COLUMNS,
        heightCls,
        focusIndicatorCls,
        actionsOffsetCls,
      )}
    >
      <RowGlyph
        state={agent.state}
        pending={agent.pending}
        stale={stale}
        skippedBy={agent.skippedBy}
        needKind={agent.needs?.kind ?? null}
        className="col-start-1 row-start-1"
      />
      <Sigil
        name={agent.name}
        size={18}
        state={agent.state}
        stale={stale}
        className="col-start-3 row-start-1"
      />
      <span role="gridcell" className="col-start-5 row-start-1 flex min-w-0 items-center gap-2">
        <AgentName agent={agent} />
      </span>
      <span
        role="gridcell"
        className={cn("col-start-7 row-start-1 truncate text-right text-xs whitespace-nowrap tabular-nums", tokenFormatted === "—" ? "text-subtle" : "text-muted")}
      >
        {tokenFormatted}
      </span>
      <span
        role="gridcell"
        className={cn("col-start-9 row-start-1 truncate text-right font-mono text-[11.5px] whitespace-nowrap tabular-nums", isTimeDimmed ? "text-subtle" : "text-muted")}
      >
        {durationFormatted}
      </span>
      <span role="gridcell" className="col-start-11 row-start-1">
        <ShareBar agent={agent} finale={finale} />
      </span>
      {secondaryDetail ? (
        <span className="col-start-5 col-end-12 row-start-2 flex min-w-0 items-center gap-1.5 truncate text-xs leading-4 whitespace-nowrap text-muted">
          <SublineNarrativeBody sublineDetail={secondaryDetail} />
        </span>
      ) : null}
      {focused ? (
        <span className={cn("rowacts absolute right-3", isExpandedRow ? "top-[3px]" : "top-1/2 -translate-y-1/2")}>
          <ActionControlsPlate
            agent={agent}
            readOnly={readOnly}
            confirm={confirm}
            onAction={onAction}
            onConfirm={onConfirm}
            onInspect={() => onInspect(agent.id)}
          />
        </span>
      ) : null}
      {peek ? <Peek agent={agent} run={run} stale={stale} /> : null}
    </div>
  );
});

export interface NeedRowProps {
  style?: CSSProperties;
  onReview(need: RunNeedVM): void;
  onFocus(id: string): void;
  focused: boolean;
  clock: number;
  need: RunNeedVM;
}

export const NeedRow = forwardRef<HTMLDivElement, NeedRowProps>(function NeedRow(props, ref) {
  const { need, clock, focused, onFocus, onReview, style } = props;
  const requestIdKey = `need:${need.requestId}`;
  const elapsedPeriod = Math.max(0, clock - (need.askedAt ?? clock));
  const timestampText = need.askedAt !== null
    ? `Asked ${durationText(elapsedPeriod)} ago${need.phase ? `, during ${need.phase}` : ""}.`
    : "Asked during the run.";
  const isInputQuery = need.kind === "input";

  const accessibilityNarrative = `Waiting for you, ${isInputQuery ? "Muse asks a question" : "Muse wants to run a command"}${need.command ? `: ${need.command}` : ""}. ${timestampText} Muse does not say which agent asked.`;

  const focusClasses = focused
    ? "bg-active before:absolute before:top-1 before:bottom-1 before:left-0 before:w-0.5 before:rounded-sm before:bg-focus before:content-['']"
    : "hover:bg-hover";

  return (
    <div
      role="row"
      id={`crew-row-${requestIdKey}`}
      tabIndex={focused ? 0 : -1}
      ref={ref}
      aria-selected={focused}
      aria-label={accessibilityNarrative}
      onFocus={() => onFocus(requestIdKey)}
      onClick={() => onFocus(requestIdKey)}
      style={style}
      className={cn(
        "relative grid min-h-11 items-center px-4 pt-[3px] pb-1 outline-none",
        ROSTER_COLUMNS,
        focusClasses,
      )}
    >
      <span
        className={cn(
          "col-start-1 row-start-1 flex size-4 items-center justify-center",
          isInputQuery ? "text-status-input" : "text-warn",
        )}
      >
        {isInputQuery ? <ChatCircleDotsIcon size={14} /> : <ShieldWarningIcon size={14} />}
      </span>
      <span
        role="gridcell"
        className="col-start-3 col-end-12 row-start-1 flex min-w-0 items-center gap-2 text-sm leading-[18px] whitespace-nowrap"
      >
        <span className="font-medium text-warn-text">Waiting for you</span>
        <span className="truncate text-muted">{isInputQuery ? "Muse asks" : "Muse wants to run"}</span>
        {need.command ? (
          <span
            className={cn(
              "inline-flex h-5 min-w-0 items-center truncate rounded-[5px] bg-sunken px-1.5 text-[11.5px] text-fg shadow-[0_0_0_1px_var(--border)]",
              !isInputQuery && "font-mono",
            )}
          >
            {isInputQuery ? `“${need.command}”` : need.command}
          </span>
        ) : null}
      </span>
      <span className="col-start-3 col-end-12 row-start-2 truncate text-xs leading-4 text-subtle">
        {timestampText} Muse does not say which agent asked.
      </span>
      {focused ? (
        <span className="absolute top-[3px] right-3 z-[1] inline-flex items-center gap-0.5 rounded-md bg-raised p-px shadow-btn">
          <Button size="sm" variant="secondary" className="h-6 gap-1 px-2 text-xs" onClick={() => onReview(need)}>
            {isInputQuery ? <ChatCircleDotsIcon size={12} /> : <EyeIcon size={12} />}
            {isInputQuery ? "Answer" : "Review"}
          </Button>
          <span className="flex size-6 items-center justify-center text-subtle">
            <CaretRightIcon size={12} />
          </span>
        </span>
      ) : null}
    </div>
  );
});
