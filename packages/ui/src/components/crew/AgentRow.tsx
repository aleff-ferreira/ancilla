import { memo, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { formatTokens } from "../../model/format.js";
import { canStopAgent, durationText, usageTotal, type AgentVM } from "../../model/crew.js";
import { ArrowCounterClockwiseIcon, CaretRightIcon, ChatCircleDotsIcon, EyeIcon, SkipForwardIcon, StopCircleIcon } from "../ui/icons.js";
import { Button, cn } from "../ui/primitives.js";
import { AgentName } from "./AgentName.js";
import { NOTHING_TO_COMPARE, NOT_CONFIRMED, agoText, compactState, noReason, plural, stateSentence } from "./cardCopy.js";
import { Sigil } from "./Sigil.js";
import { StateGlyph } from "./StateGlyph.js";
import { useBreath } from "./useBreath.js";

export type RowAction = "review" | "answer" | "retry" | "skip" | "stop";
export type ConfirmAction = "skip" | "stop";

export interface AgentRowProps {
  agent: AgentVM;
  /** `attention` is the two-line row with the reason and the action; `compact` the 32 px row of an open phase. */
  variant: "attention" | "compact" | "roster";
  selected: boolean;
  readOnly: boolean;
  stale?: boolean;
  /** The run ended: a done agent's share bar turns ok. */
  finale?: boolean;
  /** An action awaiting an inline confirm on this row. */
  confirm?: ConfirmAction | null;
  /** The instant the agent's clocks were read at, for the ages a row says. */
  clockAt?: number;
  onAction?: (id: string, action: RowAction) => void;
  onInspect: (id: string) => void;
  onSelect?: (id: string) => void;
  /** Ask before a skip or a stop; null withdraws the question. */
  onConfirm?: (id: string, action: ConfirmAction | null) => void;
}

/** A share bar: the agent's time over the longest finished agent; past 1 it fills and hatches. */
export function ShareBar({ value, tone }: { value: number | null; tone: string }) {
  if (value === null) return <span className="crew-share" aria-hidden="true" />;
  if (value > 1) {
    return (
      <span className="crew-share" aria-hidden="true">
        <span className={tone} style={{ width: "100%" }} />
        <span className="over" style={{ width: "100%" }} />
      </span>
    );
  }
  return (
    <span className="crew-share" aria-hidden="true">
      <span className={tone} style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  );
}

function barTone(agent: AgentVM, finale: boolean): string {
  if (agent.state === "failed") return "fail";
  if (agent.state === "working" || agent.state === "finishing" || agent.state === "no-update" || agent.state === "waiting-on-you") return "work";
  return finale && agent.state === "done" ? "ok" : "";
}

function stopRow(event: MouseEvent | KeyboardEvent): void {
  event.stopPropagation();
}

/** The two-line copy of an attention row: what happened, why, and what can be done (SPEC §14). */
function attentionCopy(agent: AgentVM, clockAt: number | undefined): { l1: ReactNode; tone: string; l2: string; mono: boolean; actions: RowAction[] } {
  if (agent.pending === "retry") {
    return { l1: <><b>Retrying</b> · attempt {agent.attempt + 1} starting</>, tone: "work", l2: NOT_CONFIRMED, mono: false, actions: [] };
  }
  if (agent.pending === "stop") {
    return { l1: <><b>Stopping…</b>{agent.runningMs !== null ? <> · ran {durationText(agent.runningMs)}</> : null}</>, tone: "", l2: NOT_CONFIRMED, mono: false, actions: [] };
  }
  switch (agent.state) {
    case "waiting-on-you": {
      const need = agent.needs;
      const asked = need?.askedAt !== null && need?.askedAt !== undefined && clockAt !== undefined ? `asked ${agoText(clockAt - need.askedAt)}` : null;
      if (need?.kind === "input") {
        return { l1: <><b>Asks you</b>{need.command ? <> · {need.command}</> : null}</>, tone: "need", l2: asked ?? "Muse is waiting for an answer.", mono: false, actions: ["answer"] };
      }
      return { l1: <><b>Waiting for you</b><span className="opt"> · wants to run</span></>, tone: "need", l2: asked ?? "The request is in the dock.", mono: false, actions: ["review"] };
    }
    case "failed": {
      if (agent.research) {
        // A worker gets no retry or skip: the supervisor decides what happens to its topic.
        const word = agent.research.wireState === "timed_out" ? "Timed out" : "Failed";
        const after = agent.durationMs !== null ? ` after ${durationText(agent.durationMs)}` : "";
        return { l1: <><b>{word}</b>{after}</>, tone: "fail", l2: agent.failure?.text ?? noReason(agent), mono: false, actions: [] };
      }
      const after = `after ${plural(agent.attempt, "attempt")}${agent.durationMs !== null ? ` · ${durationText(agent.durationMs)}` : ""}`;
      return { l1: <><b>Failed</b> {after}</>, tone: "fail", l2: agent.failure?.text ?? noReason(agent), mono: Boolean(agent.failure?.text), actions: agent.kind === "workflow" ? ["retry", "skip"] : [] };
    }
    case "no-update": {
      const silence = agent.silenceMs ?? 0;
      const sinceStart = agent.runningMs === null || Math.abs(agent.runningMs - silence) < 1500;
      const longest = agent.quiet?.longestFinishedMs ?? null;
      return {
        l1: <><b>No update for {durationText(silence)}</b> · {sinceStart ? "since it started" : `running ${durationText(agent.runningMs ?? 0)}`}</>,
        tone: "",
        l2: longest !== null ? `Longer than any finished agent (${durationText(longest)}). Muse does not report what it is doing.` : NOTHING_TO_COMPARE,
        mono: false,
        actions: canStopAgent(agent) ? ["stop"] : [],
      };
    }
    default:
      return { l1: <b>{stateSentence(agent)}</b>, tone: "", l2: "", mono: false, actions: [] };
  }
}

const ACTION_LABEL: Record<RowAction, string> = { review: "Review", answer: "Answer", retry: "Retry", skip: "Skip", stop: "Stop" };

function ActionButton(props: { action: RowAction; agent: AgentVM; onClick: () => void }) {
  const icon = props.action === "review" ? <EyeIcon size={12} /> : props.action === "answer" ? <ChatCircleDotsIcon size={12} /> : props.action === "retry" ? <ArrowCounterClockwiseIcon size={12} /> : props.action === "skip" ? <SkipForwardIcon size={12} /> : <StopCircleIcon size={12} />;
  const primary = props.action === "review" || props.action === "answer";
  return (
    <Button
      size="xs"
      variant={primary ? "secondary" : "ghost"}
      aria-label={`${ACTION_LABEL[props.action]} ${props.agent.name}`}
      onClick={(event) => {
        stopRow(event);
        props.onClick();
      }}
    >
      {icon}
      <span className="lbl">{ACTION_LABEL[props.action]}</span>
    </Button>
  );
}

/** The inline confirm a skip or stop asks for: `Skip judge:perf? The run continues without it. [Skip] [Keep]`. */
function Confirm(props: { agent: AgentVM; action: ConfirmAction; onYes: () => void; onNo: () => void }) {
  const verb = props.action === "skip" ? "Skip" : "Stop";
  return (
    <>
      <span className="confirm">
        <b>{verb} {props.agent.name}?</b>
        {props.agent.kind === "workflow" ? " The run continues without it." : null}
      </span>
      <Button size="xs" variant="secondary" autoFocus onClick={(event) => { stopRow(event); props.onYes(); }}>
        {verb}
      </Button>
      <Button size="xs" variant="ghost" onClick={(event) => { stopRow(event); props.onNo(); }}>
        Keep
      </Button>
    </>
  );
}

function sameProps(a: AgentRowProps, b: AgentRowProps): boolean {
  return a.agent === b.agent && a.variant === b.variant && a.selected === b.selected && a.readOnly === b.readOnly && a.stale === b.stale
    && a.finale === b.finale && (a.confirm ?? null) === (b.confirm ?? null) && a.clockAt === b.clockAt && a.onAction === b.onAction
    && a.onInspect === b.onInspect && a.onSelect === b.onSelect && a.onConfirm === b.onConfirm;
}

/**
 * One agent as a row: the attention variant gives the reason and the action on two lines; the compact variant is
 * the 32 px row of an open phase (glyph · sigil · name · state · tokens · time · share). Rows re-render only when
 * their view-model object changes, which the model keeps stable for untouched agents.
 */
export const AgentRow = memo(function AgentRow(props: AgentRowProps) {
  const { agent, selected, readOnly } = props;
  const stale = props.stale ?? false;
  const sigilRef = useRef<HTMLSpanElement>(null);
  const still = useBreath(sigilRef, !stale && (agent.state === "working" || agent.state === "finishing"));
  const sigilState = agent.pending ? "working" : agent.state;
  const select = () => props.onSelect?.(agent.id);
  const open = () => props.onInspect(agent.id);
  const common = {
    role: "row" as const,
    "aria-selected": selected,
    tabIndex: selected ? 0 : -1,
    "data-crew-focus": "row",
    "data-agent-id": agent.id,
    "data-agent-kind": agent.kind,
    "data-agent-state": agent.state,
    onFocus: select,
    onClick: open,
  };
  if (props.variant === "attention") {
    const copy = attentionCopy(agent, props.clockAt);
    const act = (action: RowAction) => {
      if (action === "skip" || action === "stop") props.onConfirm?.(agent.id, action);
      else props.onAction?.(agent.id, action);
    };
    const confirm = props.confirm ?? null;
    return (
      <div {...common} data-attention="" className={cn("crew-att", selected && "sel")} aria-label={`${agent.name}, ${stateSentence(agent)}. ${copy.l2}`}>
        <StateGlyph agent={agent} stale={stale} />
        <Sigil ref={sigilRef} name={agent.name} size={18} state={sigilState} stale={stale} still={still} />
        <div className="l1">
          <AgentName agent={agent} className="nm" />
          <span className={cn("what", copy.tone)}>{copy.l1}</span>
          {agent.state === "waiting-on-you" && agent.needs?.kind === "approval" && agent.needs.command ? <span className="chipm">{agent.needs.command}</span> : null}
        </div>
        {copy.l2 ? <span className={cn("l2", copy.mono && "mono")} title={copy.l2}>{copy.l2}</span> : null}
        <span className="acts">
          {confirm ? (
            <Confirm agent={agent} action={confirm} onYes={() => { props.onConfirm?.(agent.id, null); props.onAction?.(agent.id, confirm); }} onNo={() => props.onConfirm?.(agent.id, null)} />
          ) : (
            <>
              {!readOnly && !stale ? copy.actions.map((action) => <ActionButton key={action} action={action} agent={agent} onClick={() => act(action)} />) : null}
              <button type="button" className="go" aria-label={`Inspect ${agent.name}`} tabIndex={-1} onClick={(event) => { stopRow(event); open(); }}>
                <CaretRightIcon size={12} />
              </button>
            </>
          )}
        </span>
      </div>
    );
  }
  const state = compactState(agent, stale);
  const tokens = agent.tokens ? usageTotal(agent.tokens) : 0;
  const time = agent.durationMs !== null ? durationText(agent.durationMs) : agent.runningMs !== null ? durationText(agent.runningMs) : "";
  const share = agent.state === "planned" || agent.state === "scheduled" ? null : agent.shareOfLongest;
  const confirm = props.confirm ?? null;
  return (
    <div
      {...common}
      className={cn("crew-ag", selected && "sel", stale && "crew-stale")}
      aria-label={`${agent.name}, ${stateSentence(agent, stale)}${tokens > 0 ? `, ${formatTokens(tokens)} tokens` : ""}${time ? `, ${time}` : ""}`}
    >
      <StateGlyph agent={agent} stale={stale} />
      <Sigil ref={sigilRef} name={agent.name} size={18} state={sigilState} stale={stale} still={still} />
      <AgentName agent={agent} className="nm" />
      {confirm ? (
        <span className="acts">
          <Confirm agent={agent} action={confirm} onYes={() => { props.onConfirm?.(agent.id, null); props.onAction?.(agent.id, confirm); }} onNo={() => props.onConfirm?.(agent.id, null)} />
        </span>
      ) : (
        <>
          <span className={cn("st", state.tone)}>
            {state.text}
            {state.dim ? <span className="dim"> {state.dim}</span> : null}
          </span>
          <span className="num tok">{tokens > 0 ? formatTokens(tokens) : <span className="opacity-60">—</span>}</span>
          <span className="num dur">{time}</span>
          <ShareBar value={share} tone={barTone(agent, props.finale ?? false)} />
        </>
      )}
    </div>
  );
}, sameProps);
