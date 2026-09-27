import {
  ArrowSquareOutIcon,
  CaretRightIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  ClockCounterClockwiseIcon,
  EyeIcon,
  FolderIcon,
  MinusCircleIcon,
  QuestionIcon,
  ShieldWarningIcon,
  StopCircleIcon,
  WarningCircleIcon,
} from "../ui/icons.js";
import type { MouseEvent, ReactNode } from "react";
import { durationText, type ActivityItemVM, type AgentState, type SummaryChip } from "../../model/crew.js";
import { IconButton, Spinner, cn } from "../ui/primitives.js";
import { Strip } from "./Strip.js";

/** A run item's strip cells and chips, which the view-model does not carry; the drawer's host reads them off the run. */
export interface ActivityRunExtra {
  groups: readonly (readonly AgentState[])[];
  chips: readonly SummaryChip[];
}

export interface ActivityItemProps {
  item: ActivityItemVM;
  now: number;
  extra?: ActivityRunExtra;
  selected: boolean;
  /** The row is asking whether to stop. */
  confirming: boolean;
  rowRef?: (el: HTMLDivElement | null) => void;
  onSelect(): void;
  onOpen(): void;
  /** Asks first; `onConfirmStop` does it. */
  onStop(): void;
  onConfirmStop(): void;
  onCancelStop(): void;
}

/** The text the model gives a question, which the row phrases as Muse asking. */
const QUESTION = "Muse asked a question";

/** The mock's `.btn.xs`: 24 px tall, 12 px text. */
export const XS_BUTTON =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none disabled:opacity-45";
export const XS_GHOST = `${XS_BUTTON} text-muted hover:bg-hover hover:text-fg`;
export const XS_SECONDARY = `${XS_BUTTON} bg-raised text-fg shadow-btn hover:bg-hover`;

/** One key per row, stable across renders, for the selection and the run extras. */
export function activityKey(item: Pick<ActivityItemVM, "kind" | "sessionId" | "itemId" | "agentId">): string {
  return `${item.kind}:${item.sessionId}:${item.itemId ?? ""}:${item.agentId ?? ""}`;
}

/** A run, task or subagent still going, which Stop can reach. */
export function stoppable(item: ActivityItemVM): boolean {
  return item.kind !== "request" && item.endedAt === null && (item.itemId ?? item.agentId) !== null;
}

/** How long ago a request was asked, a run started, or a task ended. */
export function itemElapsed(item: ActivityItemVM, now: number): string {
  const since = item.endedAt ?? item.startedAt;
  return since === null ? "" : durationText(Math.max(0, now - since));
}

const LIVE_CELLS: ReadonlySet<AgentState> = new Set(["working", "finishing", "no-update"]);

/** The question a Stop asks first, naming what it cancels when the run's cells are known. */
export function stopQuestion(item: ActivityItemVM, extra?: ActivityRunExtra): string {
  if (item.kind === "run") {
    const working = extra ? extra.groups.flat().filter((cell) => LIVE_CELLS.has(cell)).length : null;
    const agents = working === null ? "Working agents" : `${working} working ${working === 1 ? "agent" : "agents"}`;
    return `Stop the run ${item.text}? ${agents} will be cancelled. Finished work stays.`;
  }
  return `Stop ${item.text}?`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** `Judge · 6 of 10` reads with the count in bold; a line without a count stays plain. */
export function splitProgress(sub: string | null): [string, string | null] {
  if (!sub) {
    return ["", null];
  }
  const match = /^(.*?)(\d+ of \d+.*)$/.exec(sub);
  return match ? [match[1] as string, match[2] as string] : [sub, null];
}

function Glyph({ item }: { item: ActivityItemVM }) {
  let icon: ReactNode;
  switch (item.state) {
    case "request":
      icon = item.text === QUESTION ? <ChatCircleDotsIcon size={14} className="text-status-input" /> : <ShieldWarningIcon size={14} className="text-warn" />;
      break;
    case "scheduled":
    case "working":
    case "finishing":
      icon = <Spinner size={11} className="text-accent-text" />;
      break;
    case "no-update":
      icon = <CircleDashedIcon size={14} className="text-subtle" />;
      break;
    case "waiting-on-you":
      icon = <ShieldWarningIcon size={14} className="text-warn" />;
      break;
    case "failed":
      icon = <WarningCircleIcon size={14} className="text-danger" />;
      break;
    case "done":
      icon = <CheckCircleIcon size={14} className="text-ok" />;
      break;
    case "skipped":
      icon = <MinusCircleIcon size={14} className="text-subtle" />;
      break;
    default:
      icon = <QuestionIcon size={14} className="text-subtle" />;
  }
  return (
    <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
      {icon}
    </span>
  );
}

function Chip({ chip }: { chip: SummaryChip }) {
  const failed = chip.kind === "failed" || chip.kind === "run-failed";
  const tone = chip.kind === "needs" ? "bg-warn-soft text-warn-text" : failed ? "bg-danger-soft text-danger-text" : chip.kind === "stale" ? "bg-active text-subtle" : "bg-active text-muted";
  const icon =
    chip.kind === "needs" ? <ShieldWarningIcon size={12} />
    : failed ? <WarningCircleIcon size={12} />
    : chip.kind === "no-update" ? <CircleDashedIcon size={12} />
    : chip.kind === "skipped" ? <MinusCircleIcon size={12} />
    : <ClockCounterClockwiseIcon size={12} />;
  return (
    <span className={cn("inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md pr-[7px] pl-1.5 text-[11.5px] font-medium whitespace-nowrap tabular-nums", tone)}>
      {icon}
      {chip.text}
    </span>
  );
}

function Body({ item, extra }: { item: ActivityItemVM; extra?: ActivityRunExtra }) {
  if (item.kind === "request") {
    if (item.stale) {
      // A thread this client does not fold: the server counts its requests and says no more.
      return (
        <span className="min-w-0 truncate">
          <b className="font-medium text-fg">{item.text}</b>
        </span>
      );
    }
    if (item.text === QUESTION) {
      return (
        <span className="min-w-0 truncate">
          <b className="font-medium text-fg">Muse asks</b>
          {item.sub ? ` · “${item.sub}”` : null}
        </span>
      );
    }
    return (
      <>
        <span className="shrink-0">
          <b className="font-medium text-fg">Muse wants to {lowerFirst(item.text)}</b>
        </span>
        {item.sub ? (
          <code className="min-w-0 truncate rounded-[5px] bg-sunken px-1.5 py-px font-mono text-[11.5px] text-fg shadow-[0_0_0_1px_var(--border)]">{item.sub}</code>
        ) : null}
      </>
    );
  }
  if (item.kind === "run") {
    const [lead, count] = splitProgress(item.sub);
    return (
      <>
        {extra ? <Strip groups={extra.groups} /> : null}
        <span className="min-w-0 truncate">
          {lead}
          {count ? <b className="font-medium text-fg">{count}</b> : null}
        </span>
        {extra?.chips.map((chip) => <Chip key={chip.kind} chip={chip} />)}
      </>
    );
  }
  const finished = item.endedAt !== null;
  return (
    <>
      {item.kind === "task" ? (
        <code className="min-w-0 truncate font-mono text-xs text-fg">{item.text}</code>
      ) : (
        <span className="min-w-0 truncate text-fg">{item.text}</span>
      )}
      {item.sub && (finished || item.kind === "subagent") ? <span className="min-w-0 truncate">{item.sub}</span> : null}
    </>
  );
}

function handled(fn: () => void): (event: MouseEvent) => void {
  return (event) => {
    event.stopPropagation();
    fn();
  };
}

/** One row of the Activity drawer: where it is, what it is, and what can be done about it. */
export function ActivityItem(props: ActivityItemProps) {
  const { item, extra } = props;
  const canStop = stoppable(item);
  const tail = item.kind === "task" && item.endedAt === null ? item.sub : null;
  const primary = item.kind === "request"
    ? item.text === QUESTION
      ? { icon: <ChatCircleDotsIcon size={12} />, label: "Answer" }
      : { icon: <EyeIcon size={12} />, label: "Review" }
    : null;
  return (
    <div
      ref={props.rowRef}
      role="listitem"
      tabIndex={props.selected ? 0 : -1}
      aria-current={props.selected ? "true" : undefined}
      aria-label={`${item.thread}, ${item.text}`}
      data-key={activityKey(item)}
      onClick={props.onSelect}
      className={cn(
        "rounded-xl p-2 outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus",
        props.selected ? "bg-active" : "hover:bg-hover",
      )}
    >
      <div className="flex min-h-[22px] items-center gap-2 whitespace-nowrap">
        <span className="flex shrink-0 items-center gap-1 text-xs text-subtle">
          <FolderIcon size={12} aria-hidden="true" />
          {item.project}
        </span>
        <CaretRightIcon size={10} className="shrink-0 text-subtle" aria-hidden="true" />
        <span className="min-w-0 truncate text-sm font-medium text-fg">{item.thread}</span>
        <span className="ml-auto shrink-0 font-mono text-xs text-subtle tabular-nums">{itemElapsed(item, props.now)}</span>
      </div>
      <div className="mt-0.5 flex min-h-7 items-center gap-2 whitespace-nowrap text-[12.5px] text-muted">
        <Glyph item={item} />
        <Body item={item} extra={extra} />
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {primary ? (
            <button type="button" className={XS_SECONDARY} onClick={handled(props.onOpen)}>
              {primary.icon}
              {primary.label}
            </button>
          ) : (
            <button type="button" className={XS_GHOST} onClick={handled(props.onOpen)}>
              <ArrowSquareOutIcon size={12} />
              Open
            </button>
          )}
          {canStop ? (
            <IconButton size="xs" label={`Stop ${item.text}`} onClick={handled(props.onStop)}>
              <StopCircleIcon size={14} />
            </IconButton>
          ) : null}
        </span>
      </div>
      {tail ? (
        <div className="mt-0.5 ml-6 flex items-center gap-2 overflow-hidden rounded-md bg-sunken px-2 py-1 font-mono text-[11.5px] leading-4 whitespace-nowrap text-muted shadow-[0_0_0_1px_var(--border)]">
          <span className="shrink-0 text-subtle" aria-hidden="true">
            ›
          </span>
          <span className="min-w-0 truncate">{tail}</span>
        </div>
      ) : null}
      {props.confirming ? (
        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
          <span className="min-w-0 flex-1 truncate">{stopQuestion(item, extra)}</span>
          <button type="button" className={cn(XS_SECONDARY, "text-danger-text")} onClick={handled(props.onConfirmStop)}>
            Stop
          </button>
          <button type="button" className={XS_GHOST} onClick={handled(props.onCancelStop)}>
            Keep
          </button>
        </div>
      ) : null}
    </div>
  );
}
