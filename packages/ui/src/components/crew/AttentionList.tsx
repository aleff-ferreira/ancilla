import type { AgentVM, RunNeedVM } from "../../model/crew.js";
import { CaretRightIcon, ChatCircleDotsIcon, EyeIcon, ShieldWarningIcon } from "../ui/icons.js";
import { Button, cn } from "../ui/primitives.js";
import { AgentRow, type ConfirmAction, type RowAction } from "./AgentRow.js";
import { runNeedLine } from "./cardCopy.js";

export interface AttentionListProps {
  /** Waiting on you, then failed, then no update (`RunVM.attention`). */
  items: AgentVM[];
  /** Requests raised during the run that no agent can be named for (v1): shown first, at run level. */
  runNeeds: RunNeedVM[];
  clockAt: number;
  selectedId: string | null;
  readOnly: boolean;
  stale?: boolean;
  confirming?: { id: string; action: ConfirmAction } | null;
  onAction: (id: string, action: RowAction) => void;
  onInspect: (id: string) => void;
  onSelect?: (id: string) => void;
  onConfirm?: (id: string, action: ConfirmAction | null) => void;
  /** Review or Answer on a run-level request: the request panel takes focus. */
  onReview: (requestId: string) => void;
}

/** The id a run-level request row carries in the card's focus order. */
export function needRowId(need: RunNeedVM): string {
  return `need:${need.requestId}`;
}

/**
 * A request Muse raised while the run was live. The data contract has no wire link from a request to a workflow
 * child, so in v1 the row belongs to the run and says so (SPEC §5.5). The consent itself stays in the request panel.
 */
export function RunNeedRow(props: { need: RunNeedVM; clockAt: number; selected: boolean; onReview: () => void; onSelect?: () => void }) {
  const { need } = props;
  const input = need.kind === "input";
  const label = input ? "Answer" : "Review";
  const line2 = runNeedLine(need, props.clockAt);
  const id = needRowId(need);
  return (
    <div
      role="row"
      aria-selected={props.selected}
      tabIndex={props.selected ? 0 : -1}
      data-crew-focus="row"
      data-attention=""
      data-need-id={need.requestId}
      data-agent-id={id}
      className={cn("crew-att run", props.selected && "sel")}
      aria-label={`Waiting for you: ${input ? `Muse asks ${need.command ?? "a question"}` : `Muse wants to run ${need.command ?? "a command"}`}. ${line2}`}
      onFocus={props.onSelect}
      onClick={props.onReview}
    >
      <span className={cn("crew-g", input ? "input" : "need")} aria-hidden="true">
        {input ? <ChatCircleDotsIcon size={14} /> : <ShieldWarningIcon size={14} />}
      </span>
      <div className="l1">
        {input ? (
          <span className="what need">
            <b>Waiting for you</b> · Muse asks{need.command ? <span className="opt"> · “{need.command}”</span> : null}
          </span>
        ) : (
          <>
            <span className="what need">
              <b>Waiting for you</b>
              <span className="opt"> · Muse wants to run</span>
            </span>
            {need.command ? <span className="chipm">{need.command}</span> : null}
          </>
        )}
      </div>
      <span className="l2" title={line2}>{line2}</span>
      <span className="acts">
        <Button
          size="xs"
          variant="secondary"
          aria-label={`${label} the request`}
          onClick={(event) => {
            event.stopPropagation();
            props.onReview();
          }}
        >
          {input ? <ChatCircleDotsIcon size={12} /> : <EyeIcon size={12} />}
          <span className="lbl">{label}</span>
        </Button>
        <span className="go" aria-hidden="true">
          <CaretRightIcon size={12} />
        </span>
      </span>
    </div>
  );
}

/** The agents that need you, sorted first, with the reason and the action on each (SPEC §1). */
export function AttentionList(props: AttentionListProps) {
  const total = props.items.length + props.runNeeds.length;
  if (total === 0) return null;
  return (
    <>
      <div className="crew-sec">
        Needs attention <span className="n">{total}</span>
        <span className="min-w-0 flex-1" />
        <span className="lnk" aria-hidden="true">
          <kbd className="crew-kbd">n</kbd> next
        </span>
      </div>
      <div role="grid" aria-label="Needs attention" className="flex flex-col">
        {props.runNeeds.map((need) => (
          <RunNeedRow
            key={need.requestId}
            need={need}
            clockAt={props.clockAt}
            selected={props.selectedId === needRowId(need)}
            onReview={() => props.onReview(need.requestId)}
            onSelect={props.onSelect ? () => props.onSelect?.(needRowId(need)) : undefined}
          />
        ))}
        {props.items.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            variant="attention"
            selected={props.selectedId === agent.id}
            readOnly={props.readOnly}
            stale={props.stale}
            clockAt={props.clockAt}
            confirm={props.confirming?.id === agent.id ? props.confirming.action : null}
            onAction={props.onAction}
            onInspect={props.onInspect}
            onSelect={props.onSelect}
            onConfirm={props.onConfirm}
          />
        ))}
      </div>
    </>
  );
}
