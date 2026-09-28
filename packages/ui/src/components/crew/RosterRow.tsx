import { forwardRef, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import {
  ArrowCounterClockwiseIcon, CaretRightIcon, ChatCircleDotsIcon, CheckCircleIcon, CircleDashedIcon, ClockCounterClockwiseIcon,
  EyeIcon, HourglassIcon, MinusCircleIcon, QuestionIcon, ShieldWarningIcon, SkipForwardIcon, StopCircleIcon, WarningCircleIcon,
} from "../ui/icons.js";
import { canStopAgent, durationText, type AgentState, type AgentVM, type RunNeedVM, type RunVM } from "../../model/crew.js";
import { Button, Spinner, cn } from "../ui/primitives.js";
import { Peek } from "./Peek.js";
import { Sigil } from "./Sigil.js";
import { RESEARCH_OWN } from "./cardCopy.js";
import { isTall, rowLabel, subline, timeText, tokensText, type Subline } from "./panel.js";

/** The roster's columns: glyph · sigil · name · tokens · time · share, with hairline gaps between (final.css `.cols`). */
export const ROSTER_COLUMNS = "grid-cols-[16px_8px_18px_8px_minmax(0,1fr)_12px_56px_10px_56px_12px_44px]";

export type RowAction = "retry" | "skip" | "stop" | "review" | "inspect";

/** An inline question before a skip or a stop: `Skip judge:perf? The run continues without it.` */
export interface RowConfirm {
  kind: "skip" | "stop";
  id: string;
}

export interface RosterRowProps {
  agent: AgentVM;
  run: RunVM | null;
  focused: boolean;
  /** The run ended, so a finished share bar turns ok. */
  finale: boolean;
  stale: boolean;
  readOnly: boolean;
  confirm: RowConfirm | null;
  /** The peek is open under this row (Space): its facts beside it, while the row keeps focus. */
  peek?: boolean;
  onFocus(id: string): void;
  onInspect(id: string): void;
  onAction(agent: AgentVM, action: RowAction): void;
  onConfirm(confirm: RowConfirm | null): void;
  /** Rows in a virtualized list carry their offset. */
  style?: CSSProperties;
}

/** The status mark at row size: every state has its own shape, so colour never stands alone. */
export function RowGlyph(props: { state: AgentState; pending?: AgentVM["pending"]; stale?: boolean; skippedBy?: AgentVM["skippedBy"]; needKind?: "approval" | "input" | null; className?: string }) {
  const cls = cn("flex size-4 shrink-0 items-center justify-center", props.className);
  if (props.stale && (props.state === "working" || props.state === "finishing" || props.state === "no-update" || props.state === "waiting-on-you" || props.state === "scheduled")) {
    return <span className={cn(cls, "text-subtle")}><ClockCounterClockwiseIcon size={14} /></span>;
  }
  if (props.pending === "retry") return <span className={cn(cls, "text-accent-text")}><ArrowCounterClockwiseIcon size={14} /></span>;
  if (props.pending === "stop") return <span className={cn(cls, "text-accent-text")}><Spinner size={11} /></span>;
  switch (props.state) {
    case "done": return <span className={cn(cls, "text-ok")}><CheckCircleIcon size={14} /></span>;
    case "failed": return <span className={cn(cls, "text-danger")}><WarningCircleIcon size={14} /></span>;
    case "waiting-on-you":
      return <span className={cn(cls, props.needKind === "input" ? "text-status-input" : "text-warn")}>{props.needKind === "input" ? <ChatCircleDotsIcon size={14} /> : <ShieldWarningIcon size={14} />}</span>;
    case "no-update": return <span className={cn(cls, "text-subtle")}><CircleDashedIcon size={14} /></span>;
    case "working": case "finishing": return <span className={cn(cls, "text-accent-text")}><Spinner size={11} /></span>;
    case "planned": return <span className={cls}><span className="size-[11px] rounded-full border-[1.25px] border-dashed border-line-strong" /></span>;
    case "scheduled": return <span className={cls}><span className="size-[11px] rounded-full shadow-[inset_0_0_0_1.5px_var(--border-strong)]" /></span>;
    case "skipped": return <span className={cn(cls, "text-subtle")}>{props.skippedBy === "run" ? <StopCircleIcon size={14} /> : <MinusCircleIcon size={14} />}</span>;
    case "unknown": return <span className={cn(cls, "text-subtle")}><QuestionIcon size={14} /></span>;
  }
}

/** A prefixed name: `judge:` in the subtle tone, `perf` in the row's. */
export function AgentName(props: { agent: Pick<AgentVM, "display" | "kind">; className?: string }) {
  return (
    <span className={cn("truncate", props.agent.kind === "task" ? "font-mono text-xs" : "text-sm leading-[18px] font-medium", props.className)}>
      {props.agent.display.prefix ? <span className="text-subtle">{props.agent.display.prefix}</span> : null}
      {props.agent.display.short}
    </span>
  );
}

/** The share of the longest finished agent, 44 px wide; past 1 the bar fills and a hatch says so. */
export function ShareBar(props: { agent: AgentVM; finale: boolean; className?: string }) {
  const { agent } = props;
  if (agent.state === "planned" || agent.state === "scheduled") return <span className={cn("block h-1.5", props.className)} aria-hidden="true" />;
  const share = agent.shareOfLongest;
  const fill = agent.state === "failed" ? "bg-danger"
    : agent.state === "no-update" ? "bg-[repeating-linear-gradient(135deg,var(--accent)_0_2px,color-mix(in_oklab,var(--accent)_30%,var(--bg-raised))_2px_4px)]"
    : agent.state === "waiting-on-you" ? "bg-warn"
    : agent.state === "working" || agent.state === "finishing" ? "bg-accent"
    : props.finale && agent.state === "done" ? "bg-[var(--lane-done)]"
    : "bg-[var(--bar-fill)]";
  return (
    <span className={cn("relative block h-1.5 overflow-hidden rounded-full bg-active", props.className)} aria-hidden="true">
      {share !== null ? <span className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-[var(--dur-fill)]", fill)} style={{ width: `${Math.min(100, Math.round(share * 100))}%` }} /> : null}
      {share !== null && share > 1 ? <span className="absolute inset-0 rounded-full bg-[repeating-linear-gradient(135deg,var(--hatch)_0_2px,transparent_2px_4px)]" /> : null}
    </span>
  );
}

function SublineText(props: { sub: Subline }) {
  const tone = { fail: "text-danger-text", need: "text-warn-text", work: "text-accent-text", mute: "text-muted" }[props.sub.tone];
  return (
    <>
      <span className={cn("font-medium", tone)}>{props.sub.word}</span>
      {props.sub.tag ? (
        <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-2xs font-medium text-muted shadow-[inset_0_0_0_1px_var(--border)] tabular-nums">
          {props.sub.word === "Running" ? <HourglassIcon size={11} /> : <CircleDashedIcon size={11} />}
          {props.sub.tag}
        </span>
      ) : null}
      {props.sub.rest.map((part, index) => (
        <span key={index} className="contents">
          <span className="text-subtle">·</span>
          <span className={cn("truncate", props.sub.mono && index === props.sub.rest.length - 1 && "font-mono text-[11.5px]")}>{part}</span>
        </span>
      ))}
    </>
  );
}

/** What the focused row can do, on an opaque plate so the columns under it stay readable. */
function RowActions(props: { agent: AgentVM; readOnly: boolean; confirm: RowConfirm | null; onAction: RosterRowProps["onAction"]; onConfirm: RosterRowProps["onConfirm"]; onInspect(): void }) {
  const { agent } = props;
  const plate = "absolute right-3 z-[1] inline-flex items-center gap-0.5 rounded-md bg-raised p-px shadow-btn";
  if (props.confirm && props.confirm.id === agent.id) {
    const skip = props.confirm.kind === "skip";
    return (
      <span className={cn(plate, "gap-1.5 pl-2 text-xs text-fg")} role="group" aria-label={skip ? "Confirm skip" : "Confirm stop"}>
        <span className="whitespace-nowrap">{skip ? `Skip ${agent.name}? The run continues without it.` : `Stop ${agent.name}?`}</span>
        <Button size="sm" variant="secondary" className="h-6 px-2 text-xs" onClick={() => { props.onConfirm(null); props.onAction(agent, skip ? "skip" : "stop"); }}>
          {skip ? "Skip" : "Stop"}
        </Button>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => props.onConfirm(null)}>Keep</Button>
      </span>
    );
  }
  const buttons: ReactNode[] = [];
  const small = "h-6 gap-1 px-2 text-xs";
  // A research worker takes no control of its own, so its plate says why and offers Inspect alone.
  if (!props.readOnly && agent.pending === null && agent.kind !== "research") {
    if (agent.state === "failed" && agent.kind === "workflow") {
      buttons.push(
        <Button key="retry" size="sm" variant="ghost" className={small} onClick={() => props.onAction(agent, "retry")}><ArrowCounterClockwiseIcon size={12} />Retry</Button>,
        <Button key="skip" size="sm" variant="ghost" className={small} onClick={() => props.onConfirm({ kind: "skip", id: agent.id })}><SkipForwardIcon size={12} />Skip</Button>,
      );
    } else if (agent.state === "waiting-on-you") {
      buttons.push(<Button key="review" size="sm" variant="secondary" className={small} onClick={() => props.onAction(agent, "review")}>{agent.needs?.kind === "input" ? "Answer" : "Review"}</Button>);
    } else if (canStopAgent(agent) && (agent.state === "working" || agent.state === "finishing" || agent.state === "no-update" || agent.state === "scheduled")) {
      buttons.push(<Button key="stop" size="sm" variant="ghost" className={small} onClick={() => props.onConfirm({ kind: "stop", id: agent.id })}><StopCircleIcon size={12} />Stop</Button>);
    }
  }
  if (buttons.length === 0 || agent.state === "working" || agent.state === "finishing" || agent.state === "no-update" || agent.state === "scheduled") {
    buttons.push(<Button key="inspect" size="sm" variant="ghost" className={small} onClick={props.onInspect}><EyeIcon size={12} />Inspect</Button>);
  }
  return <span className={plate} title={agent.kind === "research" ? RESEARCH_OWN : undefined}>{buttons}</span>;
}

/**
 * One agent in the roster: glyph · sigil · name · tokens · time · share, 32 px, or 44 with the state's second line.
 * The focused row carries the focus bar and its actions; Enter opens the inspector.
 */
export const RosterRow = forwardRef<HTMLDivElement, RosterRowProps>(function RosterRow(props, ref) {
  const { agent } = props;
  const tall = isTall(agent);
  const sub = tall ? subline(agent, props.run) : null;
  const tokens = tokensText(agent);
  const time = timeText(agent);
  const dim = time === "—" || (agent.durationMs === null && agent.state !== "done");
  /** A click on the row's own buttons, or inside its peek, is theirs rather than the row's. */
  const own = (event: MouseEvent<HTMLElement>) => !(event.target as HTMLElement).closest("button, .crew-peek");
  return (
    <div
      ref={ref}
      role="row"
      id={`crew-row-${agent.id}`}
      data-agent={agent.id}
      tabIndex={props.focused ? 0 : -1}
      aria-selected={props.focused}
      aria-label={rowLabel(agent, props.run)}
      onFocus={() => props.onFocus(agent.id)}
      onClick={(event) => {
        if (!own(event)) return;
        props.onFocus(agent.id);
        props.onInspect(agent.id);
      }}
      onDoubleClick={(event) => { if (own(event)) props.onInspect(agent.id); }}
      style={props.style}
      className={cn(
        "relative grid items-center px-4 outline-none",
        ROSTER_COLUMNS,
        tall ? "min-h-11 pt-[3px] pb-1" : "min-h-8",
        props.focused && "bg-active before:absolute before:top-1 before:bottom-1 before:left-0 before:w-0.5 before:rounded-sm before:bg-focus before:content-['']",
        !props.focused && "hover:bg-hover",
        tall && props.focused && "[&>.rowacts]:top-[3px]",
      )}
    >
      <RowGlyph state={agent.state} pending={agent.pending} stale={props.stale} skippedBy={agent.skippedBy} needKind={agent.needs?.kind ?? null} className="col-start-1 row-start-1" />
      <Sigil name={agent.name} size={18} state={agent.state} stale={props.stale} className="col-start-3 row-start-1" />
      <span role="gridcell" className="col-start-5 row-start-1 flex min-w-0 items-center gap-2">
        <AgentName agent={agent} />
      </span>
      <span role="gridcell" className={cn("col-start-7 row-start-1 truncate text-right text-xs whitespace-nowrap tabular-nums", tokens === "—" ? "text-subtle" : "text-muted")}>{tokens}</span>
      <span role="gridcell" className={cn("col-start-9 row-start-1 truncate text-right font-mono text-[11.5px] whitespace-nowrap tabular-nums", dim ? "text-subtle" : "text-muted")}>{time}</span>
      <span role="gridcell" className="col-start-11 row-start-1">
        <ShareBar agent={agent} finale={props.finale} />
      </span>
      {sub ? (
        <span className="col-start-5 col-end-12 row-start-2 flex min-w-0 items-center gap-1.5 truncate text-xs leading-4 whitespace-nowrap text-muted">
          <SublineText sub={sub} />
        </span>
      ) : null}
      {props.focused ? (
        <span className={cn("rowacts absolute right-3", tall ? "top-[3px]" : "top-1/2 -translate-y-1/2")}>
          <RowActions agent={agent} readOnly={props.readOnly} confirm={props.confirm} onAction={props.onAction} onConfirm={props.onConfirm} onInspect={() => props.onInspect(agent.id)} />
        </span>
      ) : null}
      {props.peek ? <Peek agent={agent} run={props.run} stale={props.stale} /> : null}
    </div>
  );
});

export interface NeedRowProps {
  need: RunNeedVM;
  clock: number;
  focused: boolean;
  onFocus(id: string): void;
  onReview(need: RunNeedVM): void;
  style?: CSSProperties;
}

/** A request the run raised that no agent can be named for (v1): it belongs to the run, so it heads the roster. */
export const NeedRow = forwardRef<HTMLDivElement, NeedRowProps>(function NeedRow(props, ref) {
  const { need } = props;
  const id = `need:${need.requestId}`;
  const asked = need.askedAt !== null ? `Asked ${durationText(Math.max(0, props.clock - need.askedAt))} ago${need.phase ? `, during ${need.phase}` : ""}.` : "Asked during the run.";
  const input = need.kind === "input";
  return (
    <div
      ref={ref}
      role="row"
      id={`crew-row-${id}`}
      tabIndex={props.focused ? 0 : -1}
      aria-selected={props.focused}
      aria-label={`Waiting for you, ${input ? "Muse asks a question" : "Muse wants to run a command"}${need.command ? `: ${need.command}` : ""}. ${asked} Muse does not say which agent asked.`}
      onFocus={() => props.onFocus(id)}
      onClick={() => props.onFocus(id)}
      style={props.style}
      className={cn(
        "relative grid min-h-11 items-center px-4 pt-[3px] pb-1 outline-none",
        ROSTER_COLUMNS,
        props.focused ? "bg-active before:absolute before:top-1 before:bottom-1 before:left-0 before:w-0.5 before:rounded-sm before:bg-focus before:content-['']" : "hover:bg-hover",
      )}
    >
      <span className={cn("col-start-1 row-start-1 flex size-4 items-center justify-center", input ? "text-status-input" : "text-warn")}>
        {input ? <ChatCircleDotsIcon size={14} /> : <ShieldWarningIcon size={14} />}
      </span>
      <span role="gridcell" className="col-start-3 col-end-12 row-start-1 flex min-w-0 items-center gap-2 text-sm leading-[18px] whitespace-nowrap">
        <span className="font-medium text-warn-text">Waiting for you</span>
        <span className="truncate text-muted">{input ? "Muse asks" : "Muse wants to run"}</span>
        {need.command ? (
          <span className={cn("inline-flex h-5 min-w-0 items-center truncate rounded-[5px] bg-sunken px-1.5 text-[11.5px] text-fg shadow-[0_0_0_1px_var(--border)]", !input && "font-mono")}>
            {input ? `“${need.command}”` : need.command}
          </span>
        ) : null}
      </span>
      <span className="col-start-3 col-end-12 row-start-2 truncate text-xs leading-4 text-subtle">{asked} Muse does not say which agent asked.</span>
      {props.focused ? (
        <span className="absolute top-[3px] right-3 z-[1] inline-flex items-center gap-0.5 rounded-md bg-raised p-px shadow-btn">
          <Button size="sm" variant="secondary" className="h-6 gap-1 px-2 text-xs" onClick={() => props.onReview(need)}>
            {input ? <ChatCircleDotsIcon size={12} /> : <EyeIcon size={12} />}
            {input ? "Answer" : "Review"}
          </Button>
          <span className="flex size-6 items-center justify-center text-subtle"><CaretRightIcon size={12} /></span>
        </span>
      ) : null}
    </div>
  );
});
