import { ArrowSquareOutIcon, CaretRightIcon, ChatCircleDotsIcon, CheckCircleIcon, CircleDashedIcon, ClockCounterClockwiseIcon, EyeIcon, FolderIcon, MinusCircleIcon, QuestionIcon, ShieldWarningIcon, StopCircleIcon, WarningCircleIcon } from "../ui/icons.js";
import type { MouseEvent, ReactNode } from "react";
import { durationText, type ActivityItemVM, type AgentState, type SummaryChip } from "../../model/crew.js";
import { IconButton, Spinner, cn } from "../ui/primitives.js";
import { Strip } from "./Strip.js";

export interface ActivityRunExtra {
  readonly groups: readonly (readonly AgentState[])[];
  readonly chips: readonly SummaryChip[];
}

export interface ActivityItemProps {
  readonly item: ActivityItemVM;
  readonly now: number;
  readonly extra?: ActivityRunExtra;
  readonly selected: boolean;
  readonly confirming: boolean;
  readonly rowRef?: (node: HTMLDivElement | null) => void;
  onSelect: () => void;
  onOpen: () => void;
  onStop: () => void;
  onConfirmStop: () => void;
  onCancelStop: () => void;
}

const QUESTION_PROMPT_COPY = "Muse asked a question";

export const XS_BUTTON = "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none disabled:opacity-45";
export const XS_GHOST = `${XS_BUTTON} text-muted hover:bg-hover hover:text-fg`;
export const XS_SECONDARY = `${XS_BUTTON} bg-raised text-fg shadow-btn hover:bg-hover`;

export function activityKey(item: Pick<ActivityItemVM, "kind" | "sessionId" | "itemId" | "agentId">): string {
  const compositeTokens = [item.kind, item.sessionId, item.itemId ?? "", item.agentId ?? ""];
  return compositeTokens.join(":");
}

export function stoppable(item: ActivityItemVM): boolean {
  const isRequestKind = item.kind === "request";
  if (isRequestKind) return false;
  if (item.endedAt !== null) return false;
  const targetId = item.itemId ?? item.agentId;
  return targetId !== null && targetId !== undefined;
}

export function itemElapsed(item: ActivityItemVM, now: number): string {
  const anchorTime = item.endedAt ?? item.startedAt;
  if (anchorTime === null) {
    return "";
  }
  const deltaMs = Math.max(0, now - anchorTime);
  return durationText(deltaMs);
}

const ACTIVE_CELL_STATES: ReadonlySet<AgentState> = new Set(["working", "finishing", "no-update"]);

export function stopQuestion(item: ActivityItemVM, extra?: ActivityRunExtra): string {
  const isRunKind = item.kind === "run";
  if (isRunKind) {
    const activeWorkers = extra
      ? extra.groups.flat().filter((cellState) => ACTIVE_CELL_STATES.has(cellState)).length
      : null;
    const workerSummary = activeWorkers === null
      ? "Working agents"
      : `${activeWorkers} working ${activeWorkers === 1 ? "agent" : "agents"}`;
    return `Stop the run ${item.text}? ${workerSummary} will be cancelled. Finished work stays.`;
  }
  const fallbackPrompt = `Stop ${item.text}?`;
  return fallbackPrompt;
}

function lowerFirstChar(val: string): string {
  if (val.length === 0) return "";
  return val[0].toLowerCase() + val.slice(1);
}

export function splitProgress(sub: string | null): [string, string | null] {
  if (!sub || sub.length === 0) {
    const emptyResult: [string, string | null] = ["", null];
    return emptyResult;
  }
  const countRegex = /^(.*?)(\d+ of \d+.*)$/;
  const parsedMatch = countRegex.exec(sub);
  if (!parsedMatch) {
    return [sub, null];
  }
  return [parsedMatch[1] as string, parsedMatch[2] as string];
}

function renderStatusIcon(state: ActivityItemVM["state"], label: string): ReactNode {
  if (state === "request") {
    return label === QUESTION_PROMPT_COPY
      ? <ChatCircleDotsIcon size={14} className="text-status-input" />
      : <ShieldWarningIcon size={14} className="text-warn" />;
  }
  if (state === "working" || state === "scheduled" || state === "finishing") {
    return <Spinner size={11} className="text-accent-text" />;
  }
  if (state === "no-update") {
    return <CircleDashedIcon size={14} className="text-subtle" />;
  }
  if (state === "waiting-on-you") {
    return <ShieldWarningIcon size={14} className="text-warn" />;
  }
  if (state === "failed") {
    return <WarningCircleIcon size={14} className="text-danger" />;
  }
  if (state === "done") {
    return <CheckCircleIcon size={14} className="text-ok" />;
  }
  if (state === "skipped") {
    return <MinusCircleIcon size={14} className="text-subtle" />;
  }
  return <QuestionIcon size={14} className="text-subtle" />;
}

function ActivityStatusGlyph({ state, text }: { state: ActivityItemVM["state"]; text: string }) {
  const iconMarkup = renderStatusIcon(state, text);
  return (
    <span className={cn("flex size-4 shrink-0 items-center justify-center")} aria-hidden="true">
      {iconMarkup}
    </span>
  );
}

function resolveChipPresentation(chip: SummaryChip): { toneClass: string; iconElement: ReactNode } {
  const isFailure = chip.kind === "failed" || chip.kind === "run-failed";
  if (chip.kind === "needs") {
    return { toneClass: "bg-warn-soft text-warn-text", iconElement: <ShieldWarningIcon size={12} /> };
  }
  if (isFailure) {
    return { toneClass: "bg-danger-soft text-danger-text", iconElement: <WarningCircleIcon size={12} /> };
  }
  if (chip.kind === "no-update") {
    return { toneClass: "bg-active text-muted", iconElement: <CircleDashedIcon size={12} /> };
  }
  if (chip.kind === "skipped") {
    return { toneClass: "bg-active text-muted", iconElement: <MinusCircleIcon size={12} /> };
  }
  return { toneClass: "bg-active text-subtle", iconElement: <ClockCounterClockwiseIcon size={12} /> };
}

function ActivityChipView({ chip }: { chip: SummaryChip }) {
  const { toneClass, iconElement } = resolveChipPresentation(chip);
  const compositeChipClass = cn("inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md pr-[7px] pl-1.5 text-[11.5px] font-medium whitespace-nowrap tabular-nums", toneClass);

  return (
    <span className={compositeChipClass}>
      {iconElement}
      <span className="chip-text">{chip.text}</span>
    </span>
  );
}

function RequestContent({ item }: { item: ActivityItemVM }) {
  if (Boolean(item.stale)) {
    return (
      <span className={cn("min-w-0 truncate")}>
        <b className="font-medium text-fg">{item.text}</b>
      </span>
    );
  }

  if (item.text === QUESTION_PROMPT_COPY) {
    return (
      <span className={cn("min-w-0 truncate")}>
        <b className="font-medium text-fg">Muse asks</b>
        {item.sub && ` · “${item.sub}”`}
      </span>
    );
  }

  const promptAction = lowerFirstChar(item.text);
  return (
    <>
      <span className={cn("shrink-0")}>
        <b className="font-medium text-fg">Muse wants to {promptAction}</b>
      </span>
      {item.sub && (
        <code className="min-w-0 truncate rounded-[5px] bg-sunken px-1.5 py-px font-mono text-[11.5px] text-fg shadow-[0_0_0_1px_var(--border)]">
          {item.sub}
        </code>
      )}
    </>
  );
}

function RunContent({ item, extra }: { item: ActivityItemVM; extra?: ActivityRunExtra }) {
  const [leadSection, countSection] = splitProgress(item.sub);
  return (
    <>
      {extra && <Strip groups={extra.groups} />}
      <span className={cn("min-w-0 truncate")}>
        {leadSection}
        {countSection && <b className="font-medium text-fg">{countSection}</b>}
      </span>
      {extra?.chips.map((c) => (
        <ActivityChipView key={c.kind} chip={c} />
      ))}
    </>
  );
}

function TaskOrSubagentContent({ item }: { item: ActivityItemVM }) {
  const isFinished = item.endedAt !== null;
  const isTaskType = item.kind === "task";

  return (
    <>
      {isTaskType ? (
        <code className={cn("min-w-0 truncate font-mono text-xs text-fg")}>{item.text}</code>
      ) : (
        <span className={cn("min-w-0 truncate text-fg")}>{item.text}</span>
      )}
      {item.sub && (isFinished || item.kind === "subagent") && (
        <span className={cn("min-w-0 truncate")}>{item.sub}</span>
      )}
    </>
  );
}

function ActivityContent({ item, extra }: { item: ActivityItemVM; extra?: ActivityRunExtra }) {
  if (item.kind === "request") return <RequestContent item={item} />;
  if (item.kind === "run") return <RunContent item={item} extra={extra} />;
  return <TaskOrSubagentContent item={item} />;
}

function dispatchWithStopPropagation(action: () => void): (event: MouseEvent) => void {
  return (ev: MouseEvent) => {
    ev.stopPropagation();
    action();
  };
}

export function ActivityItem(props: ActivityItemProps) {
  const { item, extra, now, selected, confirming, rowRef, onSelect, onOpen, onStop, onConfirmStop, onCancelStop } = props;
  const canBeCancelled = stoppable(item);
  const tailSnippet = item.kind === "task" && item.endedAt === null ? item.sub : null;

  const primaryActionMeta = item.kind === "request"
    ? item.text === QUESTION_PROMPT_COPY
      ? { iconNode: <ChatCircleDotsIcon size={12} />, titleText: "Answer" }
      : { iconNode: <EyeIcon size={12} />, titleText: "Review" }
    : null;

  const accessibleRowLabel = `${item.thread}, ${item.text}`;
  const compositeKey = activityKey(item);
  const elapsedFormatted = itemElapsed(item, now);

  const rowWrapperClass = cn(
    "rounded-xl p-2 outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus",
    selected ? "bg-active" : "hover:bg-hover",
  );

  return (
    <div
      ref={rowRef}
      role="listitem"
      tabIndex={selected ? 0 : -1}
      aria-current={selected ? "true" : undefined}
      aria-label={accessibleRowLabel}
      data-key={compositeKey}
      onClick={onSelect}
      className={rowWrapperClass}
    >
      <div className={cn("flex min-h-[22px] items-center gap-2 whitespace-nowrap")}>
        <span className={cn("flex shrink-0 items-center gap-1 text-xs text-subtle")}>
          <FolderIcon size={12} aria-hidden />
          <span className="truncate">{item.project}</span>
        </span>
        <CaretRightIcon size={10} className={cn("shrink-0 text-subtle")} aria-hidden />
        <span className={cn("min-w-0 truncate text-sm font-medium text-fg")}>{item.thread}</span>
        <span className={cn("ml-auto shrink-0 font-mono text-xs text-subtle tabular-nums")}>{elapsedFormatted}</span>
      </div>

      <div className={cn("mt-0.5 flex min-h-7 items-center gap-2 whitespace-nowrap text-[12.5px] text-muted")}>
        <ActivityStatusGlyph state={item.state} text={item.text} />
        <ActivityContent item={item} extra={extra} />
        <span className={cn("ml-auto flex shrink-0 items-center gap-1")}>
          {primaryActionMeta ? (
            <button type="button" className={XS_SECONDARY} onClick={dispatchWithStopPropagation(onOpen)}>
              {primaryActionMeta.iconNode}
              {primaryActionMeta.titleText}
            </button>
          ) : (
            <button type="button" className={XS_GHOST} onClick={dispatchWithStopPropagation(onOpen)}>
              <ArrowSquareOutIcon size={12} aria-hidden />
              Open
            </button>
          )}
          {canBeCancelled && (
            <IconButton size="xs" label={`Stop ${item.text}`} onClick={dispatchWithStopPropagation(onStop)}>
              <StopCircleIcon size={14} aria-hidden />
            </IconButton>
          )}
        </span>
      </div>

      {tailSnippet && (
        <div className={cn("mt-0.5 ml-6 flex items-center gap-2 overflow-hidden rounded-md bg-sunken px-2 py-1 font-mono text-[11.5px] leading-4 whitespace-nowrap text-muted shadow-[0_0_0_1px_var(--border)]")}>
          <span className={cn("shrink-0 text-subtle")} aria-hidden>›</span>
          <span className={cn("min-w-0 truncate")}>{tailSnippet}</span>
        </div>
      )}

      {confirming && (
        <div className={cn("mt-1.5 flex items-center gap-2 text-xs text-muted")}>
          <span className={cn("min-w-0 flex-1 truncate")}>{stopQuestion(item, extra)}</span>
          <button type="button" className={cn(XS_SECONDARY, "text-danger-text")} onClick={dispatchWithStopPropagation(onConfirmStop)}>
            <span>Stop</span>
          </button>
          <button type="button" className={XS_GHOST} onClick={dispatchWithStopPropagation(onCancelStop)}>
            <span>Keep</span>
          </button>
        </div>
      )}
    </div>
  );
}
