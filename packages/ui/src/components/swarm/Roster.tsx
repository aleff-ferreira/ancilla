import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CaretDownIcon, CaretRightIcon, CheckIcon, CircleDashedIcon, MinusCircleIcon, WarningCircleIcon } from "../ui/icons.js";
import { formatTokens } from "../../model/format.js";
import type { AgentVM, PhaseVM, RunNeedVM, RunVM } from "../../model/swarm.js";
import { Spinner, cn } from "../ui/primitives.js";
import { entryHeight, phaseLabel, phaseTime, type RosterEntry, type RosterSort } from "./panel.js";
import { NeedRow, ROSTER_COLUMNS, RosterRow, type RowAction, type RowConfirm } from "./RosterRow.js";

/** Past this many rows the roster draws only what is on screen. */
export const VIRTUALIZE_AT = 60;
const OVERSCAN_PX = 240;
/** The viewport the server assumes, so the first paint of a long roster is not empty. */
const DEFAULT_VIEWPORT = 640;

export interface RosterProps {
  run: RunVM | null;
  entries: readonly RosterEntry[];
  focusId: string | null;
  finale: boolean;
  stale: boolean;
  readOnly: boolean;
  sort: RosterSort;
  confirm: RowConfirm | null;
  onSort(sort: RosterSort): void;
  onFocus(id: string): void;
  onInspect(id: string): void;
  onTogglePhase(name: string): void;
  onUnfold(name: string): void;
  onAction(agent: AgentVM, action: RowAction): void;
  onConfirm(confirm: RowConfirm | null): void;
  onReview(need: RunNeedVM): void;
  /** Row elements by id, so the panel can move focus. */
  register(id: string, element: HTMLElement | null): void;
  className?: string;
}

/** The phase head: caret, name, `2/3 · 1 failed`, a done chip, then tokens and time. */
function PhaseHead(props: { phase: PhaseVM; run: RunVM | null; open: boolean; current: boolean; pseudo: boolean; focused: boolean; stale: boolean; onToggle(): void; onFocus(): void; register(element: HTMLElement | null): void; style?: CSSProperties; sticky?: boolean }) {
  const { phase } = props;
  const planned = phase.state === "planned";
  const allDone = !planned && phase.counts.total > 0 && phase.counts.done === phase.counts.total;
  const glyph: ReactNode = planned ? null
    : phase.state === "live" ? (props.stale ? null : <Spinner size={10} className="text-accent-text" />)
    : phase.counts.failed > 0 ? <WarningCircleIcon size={12} className="text-danger" />
    : phase.counts.skipped > 0 ? <MinusCircleIcon size={12} className="text-subtle" />
    : phase.counts.unknown > 0 ? <CircleDashedIcon size={12} className="text-subtle" />
    : null;
  return (
    <div
      ref={props.register}
      role="row"
      id={`swarm-row-phase:${phase.name}`}
      tabIndex={props.focused ? 0 : -1}
      aria-selected={props.focused}
      aria-expanded={props.open}
      aria-label={phaseLabel(phase, props.run)}
      onFocus={props.onFocus}
      onClick={() => { props.onFocus(); props.onToggle(); }}
      style={props.style}
      className={cn(
        "relative flex h-[34px] cursor-default items-center gap-2 border-b border-line bg-[var(--pane-bg)] pr-4 pl-3 whitespace-nowrap outline-none select-none",
        props.sticky && "sticky top-0 z-[2]",
        props.focused && "before:absolute before:top-1 before:bottom-1 before:left-0 before:w-0.5 before:rounded-sm before:bg-accent before:content-['']",
        !props.focused && "hover:bg-hover",
      )}
    >
      <span className="flex w-3 shrink-0 justify-center text-subtle">{props.open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}</span>
      <span role="gridcell" className={cn("flex min-w-0 items-center gap-2 text-sm font-semibold tracking-[-0.005em]", props.current ? "text-accent-text" : planned ? "font-medium text-subtle" : "text-fg")}>
        <span className="truncate">{phase.name}</span>
        <span className="flex items-center gap-1.5 text-xs font-normal text-subtle tabular-nums">
          {glyph}
          {planned ? `${phase.counts.planned} planned` : `${phase.counts.done}/${phase.counts.total}`}
          {phase.counts.failed > 0 ? <span className="font-medium text-danger-text">{phase.counts.failed} failed</span> : null}
          {phase.counts.noUpdate > 0 ? <span className="font-medium text-muted">{phase.counts.noUpdate} no update</span> : null}
          {phase.counts.waiting > 0 ? <span className="font-medium text-warn-text">{phase.counts.waiting} {phase.counts.waiting === 1 ? "needs" : "need"} you</span> : null}
        </span>
        {allDone ? (
          <span className="inline-flex h-5 items-center gap-1 rounded-md bg-ok-soft px-1.5 text-2xs font-medium text-ok-text">
            <CheckIcon size={11} />done
          </span>
        ) : null}
      </span>
      <span role="gridcell" className="ml-auto flex shrink-0 gap-2.5 text-xs text-subtle tabular-nums">
        <span className="min-w-11 text-right">{phase.tokens !== null && !props.pseudo ? formatTokens(phase.tokens) : "—"}</span>
        <span className="min-w-14 text-right">{props.pseudo ? "" : phaseTime(phase, props.run)}</span>
      </span>
    </div>
  );
}

function FoldRow(props: { count: number; onUnfold(): void; style?: CSSProperties }) {
  return (
    <div role="row" style={props.style} className="flex h-7 items-center pr-4 pl-[42px] text-xs text-subtle">
      <button type="button" onClick={props.onUnfold} className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 font-medium text-muted hover:bg-hover hover:text-fg">
        <CaretRightIcon size={11} />
        Show {props.count} finished
      </button>
    </div>
  );
}

function ColumnHead(props: { sort: RosterSort; onSort(sort: RosterSort): void }) {
  const head = (label: string, sort: RosterSort, align: "left" | "right") => {
    const on = props.sort === sort;
    return (
      <button
        type="button"
        role="columnheader"
        aria-sort={on ? "descending" : "none"}
        onClick={() => props.onSort(sort)}
        className={cn("inline-flex h-6 items-center gap-0.5 whitespace-nowrap", align === "right" ? "justify-end text-right" : "justify-start", on ? "font-medium text-muted" : "text-subtle hover:text-fg")}
      >
        {label}
        {on && sort !== "order" ? <CaretDownIcon size={9} /> : null}
      </button>
    );
  };
  return (
    <div role="row" className={cn("grid h-6 shrink-0 items-center border-y border-line bg-sunken px-4 text-2xs leading-4 text-subtle", ROSTER_COLUMNS)}>
      <span className="col-start-5">{head("Agent", "order", "left")}</span>
      <span className="col-start-7 flex justify-end">{head("Tokens", "tokens", "right")}</span>
      <span className="col-start-9 flex justify-end">{head("Time", "time", "right")}</span>
      <span role="columnheader" className="col-start-11 text-right">Share</span>
    </div>
  );
}

/**
 * The phase-grouped roster: a grid of rows with sticky phase heads, one tabbable row at a time, the finished agents
 * of a big phase folded behind one row, and past 60 rows only the visible ones in the DOM.
 */
export function Roster(props: RosterProps) {
  const { entries } = props;
  const virtual = entries.length > VIRTUALIZE_AT;
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: DEFAULT_VIEWPORT });
  const clock = props.run?.clockAt ?? Date.now();

  const offsets = useMemo(() => {
    const out = new Array<number>(entries.length + 1);
    let y = 0;
    entries.forEach((entry, index) => {
      out[index] = y;
      y += entryHeight(entry);
    });
    out[entries.length] = y;
    return out;
  }, [entries]);
  const total = offsets[entries.length] ?? 0;

  // A plain effect: the first paint uses the assumed viewport, and the measured one follows a frame later.
  useEffect(() => {
    if (!virtual || !scroller.current) return;
    const node = scroller.current;
    const measure = () => setViewport({ top: node.scrollTop, height: node.clientHeight || DEFAULT_VIEWPORT });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [virtual]);

  const onScroll = useCallback(() => {
    if (!virtual || !scroller.current) return;
    const node = scroller.current;
    setViewport((current) => (current.top === node.scrollTop ? current : { top: node.scrollTop, height: node.clientHeight || DEFAULT_VIEWPORT }));
  }, [virtual]);

  // Keep the focused row in view when focus moves by key.
  useEffect(() => {
    if (!virtual || props.focusId === null || !scroller.current) return;
    const index = entries.findIndex((entry) => entry.id === props.focusId);
    if (index < 0) return;
    const top = offsets[index] as number;
    const bottom = top + entryHeight(entries[index] as RosterEntry);
    const node = scroller.current;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (bottom > node.scrollTop + node.clientHeight) node.scrollTop = bottom - node.clientHeight;
  }, [virtual, props.focusId, entries, offsets]);

  let first = 0;
  let last = entries.length;
  if (virtual) {
    const from = viewport.top - OVERSCAN_PX;
    const to = viewport.top + viewport.height + OVERSCAN_PX;
    first = Math.max(0, offsets.findIndex((offset, index) => index < entries.length && offset + entryHeight(entries[index] as RosterEntry) >= from));
    const lastIndex = offsets.findIndex((offset, index) => index < entries.length && offset > to);
    last = lastIndex < 0 ? entries.length : lastIndex;
  }
  // The phase whose rows are at the top of the window stays pinned, since the real heads scroll with their rows.
  let pinned: Extract<RosterEntry, { kind: "phase" }> | null = null;
  if (virtual) {
    for (let index = 0; index < entries.length; index += 1) {
      if ((offsets[index] as number) > viewport.top) break;
      const entry = entries[index] as RosterEntry;
      if (entry.kind === "phase") pinned = entry;
    }
  }

  const render = (entry: RosterEntry, index: number): ReactNode => {
    const style: CSSProperties | undefined = virtual ? { position: "absolute", top: offsets[index], left: 0, right: 0 } : undefined;
    switch (entry.kind) {
      case "phase":
        return (
          <PhaseHead
            key={entry.id}
            phase={entry.phase}
            run={props.run}
            open={entry.open}
            current={entry.current}
            pseudo={entry.pseudo}
            focused={props.focusId === entry.id}
            stale={props.stale}
            onToggle={() => props.onTogglePhase(entry.phase.name)}
            onFocus={() => props.onFocus(entry.id)}
            register={(element) => props.register(entry.id, element)}
            style={style}
            sticky={!virtual}
          />
        );
      case "need":
        return (
          <NeedRow
            key={entry.id}
            ref={(element) => props.register(entry.id, element)}
            need={entry.need}
            clock={clock}
            focused={props.focusId === entry.id}
            onFocus={props.onFocus}
            onReview={props.onReview}
            style={style}
          />
        );
      case "fold":
        return <FoldRow key={entry.id} count={entry.count} onUnfold={() => props.onUnfold(entry.phase)} style={style} />;
      case "agent":
        return (
          <RosterRow
            key={entry.id}
            ref={(element) => props.register(entry.id, element)}
            agent={entry.agent}
            run={props.run}
            focused={props.focusId === entry.id}
            finale={props.finale}
            stale={props.stale}
            readOnly={props.readOnly}
            confirm={props.confirm}
            onFocus={props.onFocus}
            onInspect={props.onInspect}
            onAction={props.onAction}
            onConfirm={props.onConfirm}
            style={style}
          />
        );
    }
  };

  return (
    <div role="grid" aria-label="Agents" aria-rowcount={entries.length} className={cn("flex min-h-0 flex-1 flex-col", props.className)}>
      <ColumnHead sort={props.sort} onSort={props.onSort} />
      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto" data-virtual={virtual || undefined}>
        {virtual && pinned ? (
          <div className="sticky top-0 z-[2]">
            <PhaseHead
              phase={pinned.phase}
              run={props.run}
              open={pinned.open}
              current={pinned.current}
              pseudo={pinned.pseudo}
              focused={false}
              stale={props.stale}
              onToggle={() => props.onTogglePhase(pinned?.phase.name ?? "")}
              onFocus={() => props.onFocus(pinned?.id ?? "")}
              register={() => undefined}
            />
          </div>
        ) : null}
        {entries.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">No agent matches.</p>
        ) : virtual ? (
          <div className="relative" style={{ height: total }}>
            {entries.slice(first, last).map((entry, offset) => render(entry, first + offset))}
          </div>
        ) : (
          entries.map(render)
        )}
        {virtual ? (
          <p className="sticky bottom-0 border-t border-line bg-[var(--pane-bg)] px-4 py-1 text-2xs text-subtle">
            Rows are virtualized · {entries.length} of {entries.length} loaded
          </p>
        ) : null}
      </div>
    </div>
  );
}
