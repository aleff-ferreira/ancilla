import { memo, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { formatTokens } from "../../model/format.js";
import { canStopAgent, durationText, usageTotal, type AgentVM } from "../../model/crew.js";
import {
  ArrowCounterClockwiseIcon,
  CaretRightIcon,
  ChatCircleDotsIcon,
  EyeIcon,
  SkipForwardIcon,
  StopCircleIcon,
} from "../ui/icons.js";
import { Button, cn } from "../ui/primitives.js";
import { AgentName } from "./AgentName.js";
import {
  NOTHING_TO_COMPARE,
  NOT_CONFIRMED,
  agoText,
  compactState,
  noReason,
  plural,
  stateSentence,
} from "./cardCopy.js";
import { Sigil } from "./Sigil.js";
import { StateGlyph } from "./StateGlyph.js";
import { useBreath } from "./useBreath.js";

export type RowAction = "review" | "answer" | "retry" | "skip" | "stop";
export type ConfirmAction = "skip" | "stop";

export interface AgentRowProps {
  agent: AgentVM;
  selected: boolean;
  onInspect: (id: string) => void;
  variant: "attention" | "compact" | "roster";
  readOnly: boolean;
  clockAt?: number;
  stale?: boolean;
  confirm?: ConfirmAction | null;
  onAction?: (id: string, action: RowAction) => void;
  finale?: boolean;
  onConfirm?: (id: string, action: ConfirmAction | null) => void;
  onSelect?: (id: string) => void;
}

interface AttentionNarrative {
  l1: ReactNode;
  tone: string;
  l2: string;
  mono: boolean;
  actions: RowAction[];
}

const ACTION_DESCRIPTIONS: Record<RowAction, { title: string; icon: (sz: number) => ReactNode; prominent: boolean }> = {
  review: { title: "Review", icon: (s) => <EyeIcon size={s} />, prominent: true },
  answer: { title: "Answer", icon: (s) => <ChatCircleDotsIcon size={s} />, prominent: true },
  retry: { title: "Retry", icon: (s) => <ArrowCounterClockwiseIcon size={s} />, prominent: false },
  skip: { title: "Skip", icon: (s) => <SkipForwardIcon size={s} />, prominent: false },
  stop: { title: "Stop", icon: (s) => <StopCircleIcon size={s} />, prominent: false },
};

export function ShareBar({ value, tone }: { value: number | null; tone: string }) {
  if (value === null) {
    return <span className="crew-share" aria-hidden="true" />;
  }
  const isOverflow = value > 1;
  const pctString = isOverflow ? "100%" : `${Math.round(value * 100)}%`;
  return (
    <span className="crew-share" aria-hidden="true">
      <span className={tone} style={{ width: pctString }} />
      {isOverflow ? <span className="over" style={{ width: "100%" }} /> : null}
    </span>
  );
}

function resolveBarTone(agent: AgentVM, finale: boolean): string {
  const st = agent.state;
  if (st === "failed") return "fail";
  if (st === "done") return finale ? "ok" : "";
  if (st === "working" || st === "finishing" || st === "no-update" || st === "waiting-on-you") {
    return "work";
  }
  return "";
}

function preventRowBubbling(e: MouseEvent | KeyboardEvent): void {
  e.stopPropagation();
}

function resolvePendingNarrative(agent: AgentVM): AttentionNarrative | null {
  if (agent.pending === "retry") {
    const nextAttempt = agent.attempt + 1;
    return {
      l1: <><b>Retrying</b> · attempt {nextAttempt} starting</>,
      tone: "work",
      l2: NOT_CONFIRMED,
      mono: false,
      actions: [],
    };
  }
  if (agent.pending === "stop") {
    const ranClause = agent.runningMs !== null ? <> · ran {durationText(agent.runningMs)}</> : null;
    return {
      l1: <><b>Stopping…</b>{ranClause}</>,
      tone: "",
      l2: NOT_CONFIRMED,
      mono: false,
      actions: [],
    };
  }
  return null;
}

function resolveWaitingNarrative(agent: AgentVM, clockAt: number | undefined): AttentionNarrative {
  const req = agent.needs;
  const elapsedNotice = (req?.askedAt != null && clockAt !== undefined) ? `asked ${agoText(clockAt - req.askedAt)}` : null;
  const isInput = req?.kind === "input";

  if (isInput) {
    const cmdSnippet = req.command ? <> · {req.command}</> : null;
    return {
      l1: <><b>Asks you</b>{cmdSnippet}</>,
      tone: "need",
      l2: elapsedNotice ?? "Muse is waiting for an answer.",
      mono: false,
      actions: ["answer"],
    };
  }

  return {
    l1: <><b>Waiting for you</b><span className="opt"> · wants to run</span></>,
    tone: "need",
    l2: elapsedNotice ?? "The request is in the dock.",
    mono: false,
    actions: ["review"],
  };
}

function resolveFailureNarrative(agent: AgentVM): AttentionNarrative {
  const expl = agent.failure?.text ?? noReason(agent);
  if (agent.research) {
    const label = agent.research.wireState === "timed_out" ? "Timed out" : "Failed";
    const spanInfo = agent.durationMs !== null ? ` after ${durationText(agent.durationMs)}` : "";
    return {
      l1: <><b>{label}</b>{spanInfo}</>,
      tone: "fail",
      l2: expl,
      mono: false,
      actions: [],
    };
  }

  const attemptSummary = `after ${plural(agent.attempt, "attempt")}`;
  const durSummary = agent.durationMs !== null ? ` · ${durationText(agent.durationMs)}` : "";
  const allowActions = agent.kind === "workflow" ? (["retry", "skip"] as RowAction[]) : [];

  return {
    l1: <><b>Failed</b> {attemptSummary}{durSummary}</>,
    tone: "fail",
    l2: expl,
    mono: Boolean(agent.failure?.text),
    actions: allowActions,
  };
}

function resolveSilenceNarrative(agent: AgentVM): AttentionNarrative {
  const quietMs = agent.silenceMs ?? 0;
  const matchedRun = agent.runningMs === null || Math.abs(agent.runningMs - quietMs) < 1500;
  const originTag = matchedRun ? "since it started" : `running ${durationText(agent.runningMs ?? 0)}`;
  const ceiling = agent.quiet?.longestFinishedMs ?? null;
  const detail = ceiling !== null
    ? `Longer than any finished agent (${durationText(ceiling)}). Muse does not report what it is doing.`
    : NOTHING_TO_COMPARE;
  const stopAllowed = canStopAgent(agent) ? (["stop"] as RowAction[]) : [];

  return {
    l1: <><b>No update for {durationText(quietMs)}</b> · {originTag}</>,
    tone: "",
    l2: detail,
    mono: false,
    actions: stopAllowed,
  };
}

function produceAttentionNarrative(agent: AgentVM, clockAt: number | undefined): AttentionNarrative {
  const pendingStory = resolvePendingNarrative(agent);
  if (pendingStory) return pendingStory;

  const st = agent.state;
  if (st === "waiting-on-you") return resolveWaitingNarrative(agent, clockAt);
  if (st === "failed") return resolveFailureNarrative(agent);
  if (st === "no-update") return resolveSilenceNarrative(agent);

  return {
    l1: <b>{stateSentence(agent)}</b>,
    tone: "",
    l2: "",
    mono: false,
    actions: [],
  };
}

function RowActionButton(props: { act: RowAction; targetAgent: AgentVM; onTrigger: () => void }) {
  const meta = ACTION_DESCRIPTIONS[props.act];
  return (
    <Button
      size="xs"
      variant={meta.prominent ? "secondary" : "ghost"}
      aria-label={`${meta.title} ${props.targetAgent.name}`}
      onClick={(evt) => {
        preventRowBubbling(evt);
        props.onTrigger();
      }}
    >
      {meta.icon(12)}
      <span className="lbl">{meta.title}</span>
    </Button>
  );
}

function InlineConfirmBox(props: {
  agentName: string;
  isWorkflow: boolean;
  intent: ConfirmAction;
  onAgree: () => void;
  onCancel: () => void;
}) {
  const caption = props.intent === "skip" ? "Skip" : "Stop";
  return (
    <>
      <span className="confirm">
        <b>{caption} {props.agentName}?</b>
        {props.isWorkflow ? " The run continues without it." : null}
      </span>
      <Button
        size="xs"
        variant="secondary"
        autoFocus
        onClick={(evt) => {
          preventRowBubbling(evt);
          props.onAgree();
        }}
      >
        {caption}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        onClick={(evt) => {
          preventRowBubbling(evt);
          props.onCancel();
        }}
      >
        Keep
      </Button>
    </>
  );
}

function ActionControlSet(props: {
  readOnly: boolean;
  isStale: boolean;
  actions: RowAction[];
  agent: AgentVM;
  onAction: (act: RowAction) => void;
  onInspect: () => void;
}) {
  const allowActions = !props.readOnly && !props.isStale;
  return (
    <>
      {allowActions
        ? props.actions.map((act) => (
            <RowActionButton
              key={act}
              act={act}
              targetAgent={props.agent}
              onTrigger={() => props.onAction(act)}
            />
          ))
        : null}
      <button
        type="button"
        className="go"
        aria-label={`Inspect ${props.agent.name}`}
        tabIndex={-1}
        onClick={(evt) => {
          preventRowBubbling(evt);
          props.onInspect();
        }}
      >
        <CaretRightIcon size={12} />
      </button>
    </>
  );
}

function checkPropsMatch(prev: AgentRowProps, next: AgentRowProps): boolean {
  if (prev.agent !== next.agent) return false;
  if (prev.variant !== next.variant) return false;
  if (prev.selected !== next.selected) return false;
  if (prev.readOnly !== next.readOnly) return false;
  if ((prev.stale ?? false) !== (next.stale ?? false)) return false;
  if (prev.finale !== next.finale) return false;
  if ((prev.confirm ?? null) !== (next.confirm ?? null)) return false;
  if (prev.clockAt !== next.clockAt) return false;
  if (prev.onAction !== next.onAction) return false;
  if (prev.onInspect !== next.onInspect) return false;
  if (prev.onSelect !== next.onSelect) return false;
  return prev.onConfirm === next.onConfirm;
}

export const AgentRow = memo(function AgentRow(props: AgentRowProps) {
  const { agent, selected, readOnly } = props;
  const isStale = props.stale ?? false;
  const sigilElementRef = useRef<HTMLSpanElement>(null);
  const isBreathingActive = !isStale && (agent.state === "working" || agent.state === "finishing");
  const breathingStill = useBreath(sigilElementRef, isBreathingActive);
  const visualSigilState = agent.pending ? "working" : agent.state;

  const rowAttributes = {
    role: "row" as const,
    "aria-selected": selected,
    tabIndex: selected ? 0 : -1,
    "data-crew-focus": "row",
    "data-agent-id": agent.id,
    "data-agent-kind": agent.kind,
    "data-agent-state": agent.state,
    onFocus: () => props.onSelect?.(agent.id),
    onClick: () => props.onInspect(agent.id),
  };

  if (props.variant === "attention") {
    const narrative = produceAttentionNarrative(agent, props.clockAt);
    const activeConfirm = props.confirm ?? null;

    const dispatchAction = (action: RowAction) => {
      if (action === "skip" || action === "stop") {
        props.onConfirm?.(agent.id, action);
      } else {
        props.onAction?.(agent.id, action);
      }
    };

    const hasApprovalCommand = agent.state === "waiting-on-you" && agent.needs?.kind === "approval" && Boolean(agent.needs.command);
    const attentionLabel = `${agent.name}, ${stateSentence(agent)}. ${narrative.l2}`;

    return (
      <div
        {...rowAttributes}
        data-attention=""
        className={cn("crew-att", selected && "sel")}
        aria-label={attentionLabel}
      >
        <StateGlyph agent={agent} stale={isStale} />
        <Sigil
          ref={sigilElementRef}
          name={agent.name}
          size={18}
          state={visualSigilState}
          stale={isStale}
          still={breathingStill}
        />
        <div className="l1">
          <AgentName agent={agent} className="nm" />
          <span className={cn("what", narrative.tone)}>{narrative.l1}</span>
          {hasApprovalCommand ? <span className="chipm">{agent.needs?.command}</span> : null}
        </div>
        {narrative.l2 ? (
          <span className={cn("l2", narrative.mono && "mono")} title={narrative.l2}>
            {narrative.l2}
          </span>
        ) : null}
        <span className="acts">
          {activeConfirm ? (
            <InlineConfirmBox
              agentName={agent.name}
              isWorkflow={agent.kind === "workflow"}
              intent={activeConfirm}
              onAgree={() => {
                props.onConfirm?.(agent.id, null);
                props.onAction?.(agent.id, activeConfirm);
              }}
              onCancel={() => props.onConfirm?.(agent.id, null)}
            />
          ) : (
            <ActionControlSet
              readOnly={readOnly}
              isStale={isStale}
              actions={narrative.actions}
              agent={agent}
              onAction={dispatchAction}
              onInspect={() => props.onInspect(agent.id)}
            />
          )}
        </span>
      </div>
    );
  }

  const badge = compactState(agent, isStale);
  const tokenCount = agent.tokens ? usageTotal(agent.tokens) : 0;
  const timeLabel = agent.durationMs !== null
    ? durationText(agent.durationMs)
    : agent.runningMs !== null
    ? durationText(agent.runningMs)
    : "";
  const shareRatio = (agent.state === "planned" || agent.state === "scheduled") ? null : agent.shareOfLongest;
  const pendingConfirmation = props.confirm ?? null;

  const accessibleTokens = tokenCount > 0 ? `, ${formatTokens(tokenCount)} tokens` : "";
  const accessibleTime = timeLabel ? `, ${timeLabel}` : "";
  const rowSummaryLabel = `${agent.name}, ${stateSentence(agent, isStale)}${accessibleTokens}${accessibleTime}`;

  return (
    <div
      {...rowAttributes}
      className={cn("crew-ag", selected && "sel", isStale && "crew-stale")}
      aria-label={rowSummaryLabel}
    >
      <StateGlyph agent={agent} stale={isStale} />
      <Sigil
        ref={sigilElementRef}
        name={agent.name}
        size={18}
        state={visualSigilState}
        stale={isStale}
        still={breathingStill}
      />
      <AgentName agent={agent} className="nm" />
      {pendingConfirmation ? (
        <span className="acts">
          <InlineConfirmBox
            agentName={agent.name}
            isWorkflow={agent.kind === "workflow"}
            intent={pendingConfirmation}
            onAgree={() => {
              props.onConfirm?.(agent.id, null);
              props.onAction?.(agent.id, pendingConfirmation);
            }}
            onCancel={() => props.onConfirm?.(agent.id, null)}
          />
        </span>
      ) : (
        <>
          <span className={cn("st", badge.tone)}>
            {badge.text}
            {badge.dim ? <span className="dim"> {badge.dim}</span> : null}
          </span>
          <span className="num tok">
            {tokenCount > 0 ? formatTokens(tokenCount) : <span className="opacity-60">—</span>}
          </span>
          <span className="num dur">{timeLabel}</span>
          <ShareBar value={shareRatio} tone={resolveBarTone(agent, props.finale ?? false)} />
        </>
      )}
    </div>
  );
}, checkPropsMatch);
