import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CaretDownIcon, CaretRightIcon, CheckIcon, CircleDashedIcon, MinusCircleIcon, WarningCircleIcon } from "../ui/icons.js";
import { formatTokens } from "../../model/format.js";
import type { AgentVM, PhaseVM, RunNeedVM, RunVM } from "../../model/crew.js";
import { Spinner, cn } from "../ui/primitives.js";
import { entryHeight, phaseLabel, phaseTime, type RosterEntry, type RosterSort } from "./panel.js";
import { NeedRow, ROSTER_COLUMNS, RosterRow, type RowAction, type RowConfirm } from "./RosterRow.js";

export const VIRTUALIZE_AT = 60;
const OVERSCAN_BUFFER_PX = 240;
const INITIAL_VIEWPORT_HEIGHT = 640;

const BASE_PHASE_HEADER_CLS = "relative flex h-[34px] cursor-default items-center gap-2 border-b border-line bg-[var(--pane-bg)] pr-4 pl-3 whitespace-nowrap outline-none select-none";
const FOCUS_STRIP_CLS = "before:absolute before:top-1 before:bottom-1 before:left-0 before:w-0.5 before:rounded-sm before:bg-focus before:content-['']";

type SortChangeHandler = (nextSort: RosterSort) => void;
type ElementFocusHandler = (rowId: string) => void;
type ElementInspectHandler = (agentId: string) => void;
type PhaseToggleHandler = (phaseName: string) => void;
type PhaseUnfoldHandler = (phaseName: string) => void;
type ActionDispatchHandler = (targetAgent: AgentVM, act: RowAction) => void;
type ConfirmDispatchHandler = (confirmState: RowConfirm | null) => void;
type NeedReviewHandler = (needItem: RunNeedVM) => void;
type DOMRegistrationHandler = (elementId: string, node: HTMLElement | null) => void;

export interface RosterProps {
  entries: readonly RosterEntry[];
  sort: RosterSort;
  onSort: SortChangeHandler;
  focusId: string | null;
  onFocus: ElementFocusHandler;
  run: RunVM | null;
  onInspect: ElementInspectHandler;
  readOnly: boolean;
  onAction: ActionDispatchHandler;
  peekId?: string | null;
  onConfirm: ConfirmDispatchHandler;
  stale: boolean;
  onTogglePhase: PhaseToggleHandler;
  finale: boolean;
  onUnfold: PhaseUnfoldHandler;
  confirm: RowConfirm | null;
  onReview: NeedReviewHandler;
  register: DOMRegistrationHandler;
  className?: string;
}

function resolvePhaseStatusGlyph(state: string, counts: PhaseVM["counts"], isStale: boolean): ReactNode {
  if (state === "planned") return null;
  if (state === "live") {
    return isStale ? null : <Spinner size={10} className="text-accent-text" />;
  }
  if (counts.failed > 0) {
    return <WarningCircleIcon size={12} className="text-danger" />;
  }
  if (counts.skipped > 0) {
    return <MinusCircleIcon size={12} className="text-subtle" />;
  }
  if (counts.unknown > 0) {
    return <CircleDashedIcon size={12} className="text-subtle" />;
  }
  return null;
}

function PhaseDoneBadge() {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-md bg-ok-soft px-1.5 text-2xs font-medium text-ok-text">
      <CheckIcon size={11} />done
    </span>
  );
}

function PhaseMetricsDisplay({
  tokens,
  isPseudo,
  timeString,
}: {
  tokens: number | null;
  isPseudo: boolean;
  timeString: string;
}) {
  const tokenString = tokens !== null && !isPseudo ? formatTokens(tokens) : "—";
  return (
    <span role="gridcell" className="ml-auto flex shrink-0 gap-2.5 text-xs text-subtle tabular-nums">
      <span className="min-w-11 text-right">{tokenString}</span>
      <span className="min-w-14 text-right">{timeString}</span>
    </span>
  );
}

function PhaseHead(props: {
  phase: PhaseVM;
  run: RunVM | null;
  open: boolean;
  current: boolean;
  pseudo: boolean;
  focused: boolean;
  stale: boolean;
  onToggle: () => void;
  onFocus: () => void;
  register: (el: HTMLElement | null) => void;
  style?: CSSProperties;
  sticky?: boolean;
}) {
  const { phase } = props;
  const isPlanned = phase.state === "planned";
  const isComplete = !isPlanned && phase.counts.total > 0 && phase.counts.done === phase.counts.total;
  const statusIcon = resolvePhaseStatusGlyph(phase.state, phase.counts, props.stale);

  const caretSymbol = props.open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />;

  const phaseTitleClass = cn(
    "flex min-w-0 items-center gap-2 text-sm font-semibold tracking-[-0.005em]",
    props.current ? "text-accent-text" : isPlanned ? "font-medium text-subtle" : "text-fg",
  );

  const summaryCountString = isPlanned
    ? `${phase.counts.planned} planned`
    : `${phase.counts.done}/${phase.counts.total}`;

  const headerContainerClass = cn(
    BASE_PHASE_HEADER_CLS,
    props.sticky && "sticky top-0 z-[2]",
    props.focused ? FOCUS_STRIP_CLS : "hover:bg-hover",
  );

  const durationFormatted = props.pseudo ? "" : phaseTime(phase, props.run);

  const headerAttributes = {
    ref: props.register,
    role: "row" as const,
    id: `crew-row-phase:${phase.name}`,
    tabIndex: props.focused ? 0 : -1,
    "aria-selected": props.focused,
    "aria-expanded": props.open,
    "aria-label": phaseLabel(phase, props.run),
    onFocus: props.onFocus,
    onClick: () => {
      props.onFocus();
      props.onToggle();
    },
    style: props.style,
    className: headerContainerClass,
  };

  return (
    <div {...headerAttributes}>
      <span className="flex w-3 shrink-0 justify-center text-subtle">{caretSymbol}</span>
      <span role="gridcell" className={phaseTitleClass}>
        <span className="truncate">{phase.name}</span>
        <span className="flex items-center gap-1.5 text-xs font-normal text-subtle tabular-nums">
          {statusIcon}
          {summaryCountString}
          {phase.counts.failed > 0 ? (
            <span className="font-medium text-danger-text">{phase.counts.failed} failed</span>
          ) : null}
          {phase.counts.noUpdate > 0 ? (
            <span className="font-medium text-muted">{phase.counts.noUpdate} no update</span>
          ) : null}
          {phase.counts.waiting > 0 ? (
            <span className="font-medium text-warn-text">
              {phase.counts.waiting} {phase.counts.waiting === 1 ? "needs" : "need"} you
            </span>
          ) : null}
        </span>
        {isComplete ? <PhaseDoneBadge /> : null}
      </span>
      <PhaseMetricsDisplay
        tokens={phase.tokens}
        isPseudo={props.pseudo}
        timeString={durationFormatted}
      />
    </div>
  );
}

function FoldUnfoldButton({ count, onUnfold }: { count: number; onUnfold: () => void }) {
  return (
    <button
      type="button"
      onClick={onUnfold}
      className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 font-medium text-muted hover:bg-hover hover:text-fg"
    >
      <CaretRightIcon size={11} />
      Show {count} finished
    </button>
  );
}

function FoldRow(props: { count: number; onUnfold: () => void; style?: CSSProperties }) {
  return (
    <div role="row" style={props.style} className="flex h-7 items-center pr-4 pl-[42px] text-xs text-subtle">
      <FoldUnfoldButton count={props.count} onUnfold={props.onUnfold} />
    </div>
  );
}

function HeaderSortCell({
  name,
  criterion,
  alignment,
  activeCriterion,
  onChooseSort,
}: {
  name: string;
  criterion: RosterSort;
  alignment: "left" | "right";
  activeCriterion: RosterSort;
  onChooseSort: (s: RosterSort) => void;
}) {
  const isSelectedSort = activeCriterion === criterion;
  const isRightAligned = alignment === "right";

  const btnStyle = cn(
    "inline-flex h-6 items-center gap-0.5 whitespace-nowrap",
    isRightAligned ? "justify-end text-right" : "justify-start",
    isSelectedSort ? "font-medium text-muted" : "text-subtle hover:text-fg",
  );

  const sortBtnProps = {
    type: "button" as const,
    role: "columnheader" as const,
    "aria-sort": isSelectedSort ? ("descending" as const) : ("none" as const),
    onClick: () => onChooseSort(criterion),
    className: btnStyle,
  };

  return (
    <button {...sortBtnProps}>
      {name}
      {isSelectedSort && criterion !== "order" ? <CaretDownIcon size={9} /> : null}
    </button>
  );
}

function ColumnHead(props: { sort: RosterSort; onSort: (sort: RosterSort) => void }) {
  return (
    <div role="row" className={cn("grid h-6 shrink-0 items-center border-y border-line bg-sunken px-4 text-2xs leading-4 text-subtle", ROSTER_COLUMNS)}>
      <span className="col-start-5">
        <HeaderSortCell name="Agent" criterion="order" alignment="left" activeCriterion={props.sort} onChooseSort={props.onSort} />
      </span>
      <span className="col-start-7 flex justify-end">
        <HeaderSortCell name="Tokens" criterion="tokens" alignment="right" activeCriterion={props.sort} onChooseSort={props.onSort} />
      </span>
      <span className="col-start-9 flex justify-end">
        <HeaderSortCell name="Time" criterion="time" alignment="right" activeCriterion={props.sort} onChooseSort={props.onSort} />
      </span>
      <span role="columnheader" className="col-start-11 text-right">
        Share
      </span>
    </div>
  );
}

function useRosterVirtualization(
  entries: readonly RosterEntry[],
  focusIdentifier: string | null,
  isVirtual: boolean,
) {
  const scrollElementRef = useRef<HTMLDivElement>(null);
  const [viewportBounds, setViewportBounds] = useState({ top: 0, height: INITIAL_VIEWPORT_HEIGHT });

  const positionOffsets = useMemo(() => {
    const listOffsets = new Array<number>(entries.length + 1);
    let cumulative = 0;
    for (let i = 0; i < entries.length; i += 1) {
      listOffsets[i] = cumulative;
      cumulative += entryHeight(entries[i] as RosterEntry);
    }
    listOffsets[entries.length] = cumulative;
    return listOffsets;
  }, [entries]);

  const totalPixelHeight = positionOffsets[entries.length] ?? 0;

  useEffect(() => {
    if (!isVirtual || !scrollElementRef.current) return;
    const domNode = scrollElementRef.current;
    const updateMetrics = () => {
      setViewportBounds({ top: domNode.scrollTop, height: domNode.clientHeight || INITIAL_VIEWPORT_HEIGHT });
    };
    updateMetrics();
    const resizeWatcher = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateMetrics);
    resizeWatcher?.observe(domNode);
    return () => resizeWatcher?.disconnect();
  }, [isVirtual]);

  const handleScrollEvent = useCallback(() => {
    if (!isVirtual || !scrollElementRef.current) return;
    const domNode = scrollElementRef.current;
    setViewportBounds((prev) => {
      if (prev.top === domNode.scrollTop) return prev;
      return { top: domNode.scrollTop, height: domNode.clientHeight || INITIAL_VIEWPORT_HEIGHT };
    });
  }, [isVirtual]);

  useEffect(() => {
    if (!isVirtual || focusIdentifier === null || !scrollElementRef.current) return;
    const targetIdx = entries.findIndex((item) => item.id === focusIdentifier);
    if (targetIdx < 0) return;

    const rowStart = positionOffsets[targetIdx] as number;
    const rowEnd = rowStart + entryHeight(entries[targetIdx] as RosterEntry);
    const scrollBox = scrollElementRef.current;

    if (rowStart < scrollBox.scrollTop) {
      scrollBox.scrollTop = rowStart;
    } else if (rowEnd > scrollBox.scrollTop + scrollBox.clientHeight) {
      scrollBox.scrollTop = rowEnd - scrollBox.clientHeight;
    }
  }, [isVirtual, focusIdentifier, entries, positionOffsets]);

  let startIndex = 0;
  let endIndex = entries.length;
  if (isVirtual) {
    const windowMin = viewportBounds.top - OVERSCAN_BUFFER_PX;
    const windowMax = viewportBounds.top + viewportBounds.height + OVERSCAN_BUFFER_PX;
    startIndex = Math.max(
      0,
      positionOffsets.findIndex((y, i) => i < entries.length && y + entryHeight(entries[i] as RosterEntry) >= windowMin),
    );
    const stopIdx = positionOffsets.findIndex((y, i) => i < entries.length && y > windowMax);
    endIndex = stopIdx < 0 ? entries.length : stopIdx;
  }

  let stickyHeaderPhase: Extract<RosterEntry, { kind: "phase" }> | null = null;
  if (isVirtual) {
    for (let i = 0; i < entries.length; i += 1) {
      if ((positionOffsets[i] as number) > viewportBounds.top) break;
      const currentCandidate = entries[i] as RosterEntry;
      if (currentCandidate.kind === "phase") {
        stickyHeaderPhase = currentCandidate;
      }
    }
  }

  return {
    scrollElementRef,
    handleScrollEvent,
    positionOffsets,
    totalPixelHeight,
    startIndex,
    endIndex,
    stickyHeaderPhase,
  };
}

function VirtualizedNoticeBanner({ loadedCount }: { loadedCount: number }) {
  return (
    <p className="sticky bottom-0 border-t border-line bg-[var(--pane-bg)] px-4 py-1 text-2xs text-subtle">
      Rows are virtualized · {loadedCount} of {loadedCount} loaded
    </p>
  );
}

function RosterNoMatches() {
  return <p className="px-4 py-6 text-center text-sm text-muted">No agent matches.</p>;
}

export function Roster(props: RosterProps) {
  const { entries } = props;
  const isVirtualActive = entries.length > VIRTUALIZE_AT;
  const snapshotClock = props.run?.clockAt ?? Date.now();

  const {
    scrollElementRef,
    handleScrollEvent,
    positionOffsets,
    totalPixelHeight,
    startIndex,
    endIndex,
    stickyHeaderPhase,
  } = useRosterVirtualization(entries, props.focusId, isVirtualActive);

  const renderSingleEntry = (entryItem: RosterEntry, itemIndex: number): ReactNode => {
    const layoutStyle: CSSProperties | undefined = isVirtualActive
      ? { position: "absolute", top: positionOffsets[itemIndex], left: 0, right: 0 }
      : undefined;

    switch (entryItem.kind) {
      case "phase":
        return (
          <PhaseHead
            key={entryItem.id}
            phase={entryItem.phase}
            run={props.run}
            open={entryItem.open}
            current={entryItem.current}
            pseudo={entryItem.pseudo}
            focused={props.focusId === entryItem.id}
            stale={props.stale}
            onToggle={() => props.onTogglePhase(entryItem.phase.name)}
            onFocus={() => props.onFocus(entryItem.id)}
            register={(node) => props.register(entryItem.id, node)}
            style={layoutStyle}
            sticky={!isVirtualActive}
          />
        );
      case "need":
        return (
          <NeedRow
            key={entryItem.id}
            ref={(node) => props.register(entryItem.id, node)}
            need={entryItem.need}
            clock={snapshotClock}
            focused={props.focusId === entryItem.id}
            onFocus={props.onFocus}
            onReview={props.onReview}
            style={layoutStyle}
          />
        );
      case "fold":
        return (
          <FoldRow
            key={entryItem.id}
            count={entryItem.count}
            onUnfold={() => props.onUnfold(entryItem.phase)}
            style={layoutStyle}
          />
        );
      case "agent": {
        const agentRowProps = {
          key: entryItem.id,
          ref: (node: HTMLElement | null) => props.register(entryItem.id, node),
          agent: entryItem.agent,
          run: props.run,
          peek: props.peekId === entryItem.id,
          focused: props.focusId === entryItem.id,
          confirm: props.confirm,
          onInspect: props.onInspect,
          onAction: props.onAction,
          onConfirm: props.onConfirm,
          readOnly: props.readOnly,
          onFocus: props.onFocus,
          stale: props.stale,
          finale: props.finale,
          style: layoutStyle,
        };
        return <RosterRow {...agentRowProps} />;
      }
    }
  };

  const stickyHeaderElement = isVirtualActive && stickyHeaderPhase ? (
    <div className="sticky top-0 z-[2]">
      <PhaseHead
        phase={stickyHeaderPhase.phase}
        run={props.run}
        open={stickyHeaderPhase.open}
        current={stickyHeaderPhase.current}
        pseudo={stickyHeaderPhase.pseudo}
        focused={false}
        stale={props.stale}
        onToggle={() => props.onTogglePhase(stickyHeaderPhase?.phase.name ?? "")}
        onFocus={() => props.onFocus(stickyHeaderPhase?.id ?? "")}
        register={() => undefined}
      />
    </div>
  ) : null;

  return (
    <div
      role="grid"
      aria-label="Agents"
      aria-rowcount={entries.length}
      className={cn("flex min-h-0 flex-1 flex-col", props.className)}
    >
      <ColumnHead sort={props.sort} onSort={props.onSort} />
      <div
        ref={scrollElementRef}
        onScroll={handleScrollEvent}
        className="relative min-h-0 flex-1 overflow-y-auto"
        data-virtual={isVirtualActive || undefined}
      >
        {stickyHeaderElement}
        {entries.length === 0 ? (
          <RosterNoMatches />
        ) : isVirtualActive ? (
          <div className="relative" style={{ height: totalPixelHeight }}>
            {entries.slice(startIndex, endIndex).map((entry, offset) =>
              renderSingleEntry(entry, startIndex + offset),
            )}
          </div>
        ) : (
          entries.map(renderSingleEntry)
        )}
        {isVirtualActive ? <VirtualizedNoticeBanner loadedCount={entries.length} /> : null}
      </div>
    </div>
  );
}
