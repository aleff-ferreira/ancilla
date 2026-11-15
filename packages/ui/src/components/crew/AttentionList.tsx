import type { ReactNode } from "react";
import type { AgentVM, RunNeedVM } from "../../model/crew.js";
import { CaretRightIcon, ChatCircleDotsIcon, EyeIcon, ShieldWarningIcon } from "../ui/icons.js";
import { Button, cn } from "../ui/primitives.js";
import { AgentRow, type ConfirmAction, type RowAction } from "./AgentRow.js";
import { runNeedLine } from "./cardCopy.js";

type NeedReviewCallback = (reqId: string) => void;
type AgentInspectCallback = (targetId: string) => void;
type AgentSelectCallback = (targetId: string) => void;
type AgentActionCallback = (targetId: string, act: RowAction) => void;
type AgentConfirmCallback = (targetId: string, act: ConfirmAction | null) => void;

export interface AttentionListProps {
  items: readonly AgentVM[];
  clockAt: number;
  readOnly: boolean;
  runNeeds: readonly RunNeedVM[];
  stale?: boolean;
  selectedId: string | null;
  confirming?: { id: string; action: ConfirmAction } | null;
  onReview: NeedReviewCallback;
  onAction: AgentActionCallback;
  onInspect: AgentInspectCallback;
  onSelect?: AgentSelectCallback;
  onConfirm?: AgentConfirmCallback;
}

export function needRowId(need: RunNeedVM): string {
  const identifier = need.requestId;
  return `need:${identifier}`;
}

function computeNeedAria(isPrompt: boolean, cmdString: string | null, secondLine: string): string {
  const headlineNotice = isPrompt
    ? `Muse asks ${cmdString ?? "a question"}`
    : `Muse wants to run ${cmdString ?? "a command"}`;
  return `Waiting for you: ${headlineNotice}. ${secondLine}`;
}

function NeedIconMarker({ isInput }: { isInput: boolean }) {
  const badgeCls = isInput ? "input" : "need";
  const markerIcon = isInput
    ? <ChatCircleDotsIcon size={14} />
    : <ShieldWarningIcon size={14} />;

  return (
    <span className={cn("crew-g", badgeCls)} aria-hidden="true">
      {markerIcon}
    </span>
  );
}

function NeedPrimaryLine({ isInput, command }: { isInput: boolean; command: string | null }) {
  const boldPrefix = <b>Waiting for you</b>;

  if (isInput) {
    const trailingQuote = command ? <span className="opt"> · “{command}”</span> : null;
    return (
      <div className="l1">
        <span className="what need">
          {boldPrefix} · Muse asks{trailingQuote}
        </span>
      </div>
    );
  }

  const optText = <span className="opt"> · Muse wants to run</span>;
  const chipElement = command ? <span className="chipm">{command}</span> : null;
  return (
    <div className="l1">
      <span className="what need">
        {boldPrefix}
        {optText}
      </span>
      {chipElement}
    </div>
  );
}

function TrailingCaretMarker() {
  return (
    <span className="go" aria-hidden="true">
      <CaretRightIcon size={12} />
    </span>
  );
}

function NeedButtonTray({
  isInput,
  buttonLabel,
  onTrigger,
}: {
  isInput: boolean;
  buttonLabel: string;
  onTrigger: () => void;
}) {
  const glyph = isInput ? <ChatCircleDotsIcon size={12} /> : <EyeIcon size={12} />;
  const actionBtnOptions = {
    size: "xs" as const,
    variant: "secondary" as const,
    "aria-label": `${buttonLabel} the request`,
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onTrigger();
    },
  };

  return (
    <span className="acts">
      <Button {...actionBtnOptions}>
        {glyph}
        <span className="lbl">{buttonLabel}</span>
      </Button>
      <TrailingCaretMarker />
    </span>
  );
}

export function RunNeedRow(props: {
  need: RunNeedVM;
  clockAt: number;
  selected: boolean;
  onReview: () => void;
  onSelect?: () => void;
}) {
  const item = props.need;
  const isInput = item.kind === "input";
  const verb = isInput ? "Answer" : "Review";
  const secondaryDetail = runNeedLine(item, props.clockAt);
  const compositeId = needRowId(item);
  const computedLabel = computeNeedAria(isInput, item.command, secondaryDetail);

  const containerProps = {
    role: "row" as const,
    "data-crew-focus": "row",
    tabIndex: props.selected ? 0 : -1,
    "aria-selected": props.selected,
    "data-attention": "",
    "data-need-id": item.requestId,
    "data-agent-id": compositeId,
    className: cn("crew-att run", props.selected && "sel"),
    "aria-label": computedLabel,
    onFocus: props.onSelect,
    onClick: props.onReview,
  };

  return (
    <div {...containerProps}>
      <NeedIconMarker isInput={isInput} />
      <NeedPrimaryLine isInput={isInput} command={item.command} />
      <span className="l2" title={secondaryDetail}>{secondaryDetail}</span>
      <NeedButtonTray
        isInput={isInput}
        buttonLabel={verb}
        onTrigger={props.onReview}
      />
    </div>
  );
}

function AttentionSectionBanner({ totalCount }: { totalCount: number }) {
  const shortcutCue = <kbd className="crew-kbd">n</kbd>;
  return (
    <div className="crew-sec">
      Needs attention <span className="n">{totalCount}</span>
      <span className="min-w-0 flex-1" />
      <span className="lnk" aria-hidden="true">
        {shortcutCue} next
      </span>
    </div>
  );
}

export function AttentionList(props: AttentionListProps) {
  const attentionCount = props.items.length + props.runNeeds.length;
  if (attentionCount === 0) {
    return null;
  }

  const {
    runNeeds,
    items,
    clockAt,
    selectedId,
    readOnly,
    stale,
    confirming,
    onReview,
    onSelect,
    onInspect,
    onAction,
    onConfirm,
  } = props;

  const renderNeedItem = (needVM: RunNeedVM) => {
    const key = needVM.requestId;
    const rId = needRowId(needVM);
    const isSelected = selectedId === rId;
    const selectHandler = onSelect ? () => onSelect(rId) : undefined;

    return (
      <RunNeedRow
        key={key}
        need={needVM}
        clockAt={clockAt}
        selected={isSelected}
        onReview={() => onReview(key)}
        onSelect={selectHandler}
      />
    );
  };

  const renderAgentItem = (agentVM: AgentVM) => {
    const isSelected = selectedId === agentVM.id;
    const isConfirming = confirming?.id === agentVM.id;
    const confirmAction = isConfirming ? confirming.action : null;

    return (
      <AgentRow
        key={agentVM.id}
        agent={agentVM}
        variant="attention"
        selected={isSelected}
        readOnly={readOnly}
        stale={stale}
        clockAt={clockAt}
        confirm={confirmAction}
        onAction={onAction}
        onInspect={onInspect}
        onSelect={onSelect}
        onConfirm={onConfirm}
      />
    );
  };

  return (
    <>
      <AttentionSectionBanner totalCount={attentionCount} />
      <div role="grid" aria-label="Needs attention" className="flex flex-col">
        {runNeeds.map(renderNeedItem)}
        {items.map(renderAgentItem)}
      </div>
    </>
  );
}
