import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { ArrowLeftIcon, CaretRightIcon, CircleDashedIcon, CopyIcon, DotsThreeIcon, RowsIcon, ShieldWarningIcon, SidebarSimpleIcon, SquaresFourIcon, StopCircleIcon, WarningCircleIcon } from "../ui/icons.js";
import { useApp, useController, useNow } from "../../app/context.js";
import { useOverlayDragProps } from "../../app/frame.js";
import { emptySwarmPanel, type SwarmFilter } from "../../model/store.js";
import { runLive, swarmBusy, swarmView, type AgentVM, type RunNeedVM, type RunVM } from "../../model/swarm.js";
import { isTyping } from "../requests/Requests.js";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal, Tip } from "../ui/overlays.js";
import { Button, IconButton, Kbd, Spinner, cn } from "../ui/primitives.js";
import { FilterChips } from "./FilterChips.js";
import { Inspector, type InspectorTab } from "./Inspector.js";
import { KpiStrip } from "./KpiStrip.js";
import { PanelResize } from "./PanelResize.js";
import { Roster } from "./Roster.js";
import type { RowAction, RowConfirm } from "./RosterRow.js";
import { Timeline } from "./Timeline.js";
import { chipCounts, focusOrder, issueOrder, rosterEntries, statusPill, summaryParts, visibleFilters, withPending, workingNames, type RosterSort } from "./panel.js";
import { usePanelKeys, type PanelKeyAction } from "./usePanelKeys.js";

/** The thread column keeps at least this much beside a docked panel; below it the panel overlays (SPEC §3.1). */
export const DOCK_MIN_THREAD = 560;
/** At or under this width the chips wrap and the search folds to its icon. */
export const NARROW_AT = 560;
/** From this width the inspector opens as a column beside the roster. */
export const SPLIT_AT = 760;
/** The window the server assumes, so a server render docks the default panel. */
const SERVER_WINDOW = 1440;

const EMPTY_PANEL = emptySwarmPanel();
const NO_SET: ReadonlySet<string> = new Set();

function subscribeResize(callback: () => void): () => void {
  window.addEventListener("resize", callback);
  return () => window.removeEventListener("resize", callback);
}

function useWindowWidth(): number {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth, () => SERVER_WINDOW);
}

/** The run the panel shows: the newest live one, else the newest. */
export function panelRun(runs: readonly RunVM[]): RunVM | null {
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i] as RunVM;
    if (runLive(run)) return run;
  }
  return runs[runs.length - 1] ?? null;
}

/**
 * Where a request panel is in the document, so Review can bring it into view: by its request id when the panel
 * carries one, else the first approval or question panel in the dock (Requests.tsx names them so).
 */
function reviewRequest(requestId: string | null): void {
  if (typeof document === "undefined") return;
  const own = requestId ? document.querySelector<HTMLElement>(`[data-request-id="${CSS.escape(requestId)}"]`) : null;
  const target = own ?? document.querySelector<HTMLElement>('[data-request-panel], section[aria-label="Approval needed"], section[aria-label="Muse has a question"]');
  if (!target) return;
  target.scrollIntoView({ block: "center" });
  const button = target.querySelector<HTMLElement>("button, [tabindex]");
  (button ?? target).focus({ preventScroll: true });
}

/**
 * The Swarm panel, in the slot beside a thread: everyone at once, concurrency and cost. It reads the thread's fold
 * from the store, builds the view-model itself, and docks beside the transcript when the window can afford it or
 * overlays the thread's right edge when it cannot.
 */
export function SwarmPanel(props: { sessionId: string }) {
  const { sessionId } = props;
  const controller = useController();
  const session = useApp((s) => s.sessions[sessionId] ?? null);
  const thread = useApp((s) => s.threads[sessionId] ?? null);
  const prefWidth = useApp((s) => s.prefs.swarmWidth);
  const sidebar = useApp((s) => (s.prefs.sidebarCollapsed ? 0 : s.prefs.sidebarWidth));
  const connection = useApp((s) => s.connection);
  const panel = useApp((s) => s.swarm.panels[sessionId] ?? EMPTY_PANEL);
  const pending = useApp((s) => s.swarm.pending);
  const skipped = useApp((s) => s.swarm.skipped);
  const models = useApp((s) => s.models);
  const drag = useOverlayDragProps();
  const noDrag = useOverlayDragProps("off");

  const fold = thread?.fold ?? null;
  const stale = connection !== "open" || Boolean(fold?.closed || thread?.stalled || thread?.historySync || thread?.readOnly || thread?.stale);
  const busy = fold ? swarmBusy(fold) : false;
  const now = useNow(15_000, busy && !stale);
  const sessionModel = session?.modelId ?? null;
  const view = useMemo(
    () => (fold ? swarmView(fold, session, now, { stale, partialHistory: thread?.truncated === true, pending, skipped, models, sessionModel }) : null),
    // The view moves with the agent items, the trace, the requests and the clock; a text delta elsewhere leaves it alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fold?.agentItems, fold?.swarm, fold?.approvals, fold?.userInputs, fold?.order, fold?.meta.modelId, session?.sessionId, sessionModel, now, stale, thread?.truncated, pending, skipped, models],
  );
  const shown = view ? panelRun(view.runs) : null;
  const run = useMemo(() => (shown ? withPending(shown, sessionId, pending) : null), [shown, sessionId, pending]);
  const tasks = view?.tasks ?? [];
  const subagents = view?.subagents ?? [];
  const loading = !thread || (thread.load !== "ready" && thread.load !== "error" && thread.fold.order.length === 0);

  const windowWidth = useWindowWidth();
  const room = Math.max(0, windowWidth - sidebar);
  const overlay = room - prefWidth < DOCK_MIN_THREAD;
  const width = overlay ? Math.max(320, Math.min(prefWidth, room)) : prefWidth;
  const narrow = width <= NARROW_AT;
  const split = width >= SPLIT_AT;

  const [focusId, setFocusId] = useState<string | null>(null);
  const [sort, setSort] = useState<RosterSort>("time");
  const [tab, setTab] = useState<InspectorTab>("overview");
  const [confirm, setConfirm] = useState<RowConfirm | null>(null);
  const [stopping, setStopping] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(NO_SET);
  const searchRef = useRef<HTMLInputElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const wantFocus = useRef<string | null>(null);

  const entries = useMemo(
    () => rosterEntries(run, { filter: panel.filter, query: panel.query, openPhases: panel.openPhases, sort, unfolded, tasks, subagents }),
    [run, panel.filter, panel.query, panel.openPhases, sort, unfolded, tasks, subagents],
  );
  const order = useMemo(() => focusOrder(entries), [entries]);
  const agentOrder = useMemo(() => focusOrder(entries, true), [entries]);
  const issues = useMemo(() => issueOrder(run, entries), [run, entries]);
  const everyAgent = useMemo(() => [...(run?.agents ?? []), ...tasks, ...subagents], [run, tasks, subagents]);
  const inspected = panel.mode === "inspector" && panel.inspectId !== null ? everyAgent.find((agent) => agent.id === panel.inspectId) ?? null : null;
  const mode = inspected ? "inspector" : "roster";
  const focused = focusId !== null && order.includes(focusId) ? focusId : (order[0] ?? null);
  const counts = useMemo(() => (run ? chipCounts(run) : { all: 0, needs: 0, failed: 0, noUpdate: 0, working: 0, done: 0 }), [run]);
  const closedPhases = useMemo(() => new Set(entries.filter((entry) => entry.kind === "phase" && !entry.open).map((entry) => (entry.kind === "phase" ? entry.phase.name : ""))), [entries]);
  const readOnly = Boolean(thread?.readOnly);
  const finale = run !== null && !runLive(run);

  // Focus moved by key lands on its row once the row is there.
  useEffect(() => {
    const id = wantFocus.current;
    if (id === null) return;
    const element = rows.current.get(id);
    if (element) {
      wantFocus.current = null;
      element.focus({ preventScroll: true });
      element.scrollIntoView?.({ block: "nearest" });
    }
  });

  // Opening the panel takes focus, unless the user is typing; closing gives it back to where it was.
  useEffect(() => {
    const opener = typeof document !== "undefined" ? document.activeElement : null;
    if (opener instanceof HTMLElement && !isTyping(opener)) {
      asideRef.current?.focus({ preventScroll: true });
    }
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);

  const moveFocus = useCallback((id: string | null) => {
    if (id === null) return;
    wantFocus.current = id;
    setFocusId(id);
  }, []);
  const register = useCallback((id: string, element: HTMLElement | null) => {
    if (element) rows.current.set(id, element);
    else rows.current.delete(id);
  }, []);

  const inspect = useCallback((id: string | null) => {
    setConfirm(null);
    controller.inspectAgent(sessionId, id);
    if (id !== null) setFocusId(id);
  }, [controller, sessionId]);

  const act = useCallback((agent: AgentVM, action: RowAction) => {
    if (action === "inspect") {
      inspect(agent.id);
    } else if (action === "review") {
      reviewRequest(agent.needs?.requestId ?? null);
    } else {
      void controller.swarmAction(sessionId, agent, action);
    }
  }, [controller, inspect, sessionId]);

  const review = useCallback((need: RunNeedVM) => reviewRequest(need.requestId), []);

  const togglePhase = useCallback((name: string) => controller.togglePhase(sessionId, name), [controller, sessionId]);

  const step = (list: readonly string[], from: string | null, delta: 1 | -1, wrap: boolean): string | null => {
    if (list.length === 0) return null;
    const index = from === null ? -1 : list.indexOf(from);
    if (index < 0) return delta === 1 ? (list[0] as string) : (list[list.length - 1] as string);
    const next = index + delta;
    if (next < 0 || next >= list.length) return wrap ? (list[(next + list.length) % list.length] as string) : null;
    return list[next] as string;
  };

  const target = (): AgentVM | null => inspected ?? everyAgent.find((agent) => agent.id === focused) ?? null;
  const phaseOfFocus = (): string | null => {
    const entry = entries.find((candidate) => candidate.id === focused);
    if (!entry) return run?.currentPhase ?? null;
    return entry.kind === "phase" ? entry.phase.name : entry.kind === "agent" ? entry.phase : null;
  };

  const handleKey = useCallback((action: PanelKeyAction, event: KeyboardEvent<HTMLElement>): boolean => {
    void event;
    switch (action) {
      case "next":
      case "previous": {
        const delta = action === "next" ? 1 : -1;
        if (inspected) {
          const id = step(agentOrder, inspected.id, delta, false);
          if (id !== null) inspect(id);
          if (id !== null && split) moveFocus(id);
          return true;
        }
        moveFocus(step(order, focused, delta, false));
        return true;
      }
      case "inspect":
      case "peek": {
        const entry = entries.find((candidate) => candidate.id === focused);
        if (!entry) return false;
        if (entry.kind === "phase") togglePhase(entry.phase.name);
        else if (entry.kind === "agent") inspect(entry.id);
        else if (entry.kind === "need") review(entry.need);
        return true;
      }
      case "next-issue":
      case "previous-issue": {
        const from = inspected ? inspected.id : focused;
        const id = step(issues, from, action === "next-issue" ? 1 : -1, true);
        if (id === null) return false;
        if (inspected && !id.startsWith("need:")) inspect(id);
        moveFocus(id);
        return true;
      }
      case "find":
        if (mode === "inspector" && !split) inspect(null);
        window.setTimeout(() => searchRef.current?.focus(), 0);
        return true;
      case "cycle-filter": {
        const filters = visibleFilters(counts);
        const next = filters[(filters.indexOf(panel.filter) + 1) % filters.length] as SwarmFilter;
        controller.setSwarmFilter(sessionId, next);
        return true;
      }
      case "timeline":
        controller.toggleTimeline(sessionId);
        return true;
      case "collapse-phase":
      case "expand-phase": {
        const name = phaseOfFocus();
        if (name === null) return false;
        const entry = entries.find((candidate) => candidate.kind === "phase" && candidate.phase.name === name);
        const open = entry?.kind === "phase" ? entry.open : false;
        if ((action === "collapse-phase") === open) togglePhase(name);
        if (action === "collapse-phase") moveFocus(`phase:${name}`);
        return true;
      }
      case "retry": {
        const agent = target();
        if (!agent || agent.state !== "failed" || agent.kind !== "workflow" || readOnly) return false;
        act(agent, "retry");
        return true;
      }
      case "skip": {
        const agent = target();
        if (!agent || agent.kind !== "workflow" || agent.state === "done" || agent.state === "skipped" || agent.state === "unknown" || agent.state === "planned" || readOnly) return false;
        setConfirm({ kind: "skip", id: agent.id });
        return true;
      }
      case "stop": {
        const agent = target();
        if (agent && (agent.state === "working" || agent.state === "finishing" || agent.state === "no-update" || agent.state === "scheduled" || agent.state === "waiting-on-you") && !readOnly) {
          setConfirm({ kind: "stop", id: agent.id });
          return true;
        }
        if (run && runLive(run) && !readOnly) {
          setStopping(true);
          return true;
        }
        return false;
      }
      case "tab-overview": setTab("overview"); return true;
      case "tab-lifecycle": setTab("lifecycle"); return true;
      case "tab-result": setTab("result"); return true;
      case "back":
        if (confirm) {
          setConfirm(null);
          return true;
        }
        if (inspected) {
          const id = inspected.id;
          inspect(null);
          moveFocus(id);
          return true;
        }
        controller.toggleSwarmPanel(false);
        return true;
    }
  }, [act, agentOrder, confirm, controller, counts, entries, focused, inspect, inspected, issues, mode, moveFocus, order, panel.filter, readOnly, review, run, sessionId, split, togglePhase]);
  const onKeyDown = usePanelKeys(mode, handleKey);

  const style = { "--pane-bg": overlay ? "var(--bg-raised)" : "var(--bg)", width } as CSSProperties;
  const pill = run ? statusPill(run) : null;
  const crumb = mode === "inspector" && !split && inspected;
  const stopRun = () => {
    if (!run) return;
    setStopping(false);
    void controller.stopRun(sessionId, run.itemId);
  };

  const head = (
    <header data-drag-region {...drag} className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2.5 pl-4">
      {crumb ? (
        <>
          <Tip label="Back to the run" shortcut={["Esc"]}>
            <IconButton label="Back to the run" size="sm" onClick={() => { const id = inspected.id; inspect(null); moveFocus(id); }} {...noDrag}>
              <ArrowLeftIcon size={15} />
            </IconButton>
          </Tip>
          <nav aria-label="Inspector" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-muted whitespace-nowrap">
            <span className="max-w-[190px] truncate text-subtle">{run?.name ?? "Swarm"}</span>
            <CaretRightIcon size={10} className="shrink-0 text-subtle" />
            <b className="truncate font-semibold tracking-[-0.01em] text-fg">{inspected.name}</b>
          </nav>
        </>
      ) : (
        <>
          <h2 className="m-0 min-w-0 truncate text-sm font-semibold tracking-[-0.01em]">{run?.name ?? (tasks.length > 0 || subagents.length > 0 ? "Agents and tasks" : "Swarm")}</h2>
          {pill ? (
            <span
              className={cn(
                "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-2xs font-medium",
                pill.tone === "run" && "bg-accent-soft text-accent-text",
                pill.tone === "ok" && "bg-ok-soft text-ok-text",
                pill.tone === "mute" && "bg-active text-muted",
                pill.tone === "fail" && "bg-danger-soft text-danger-text",
              )}
            >
              {pill.text}
            </span>
          ) : null}
          <span className="min-w-0 flex-1" />
          {run && runLive(run) && !readOnly && !run.stale ? (
            <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs text-danger-text hover:bg-danger-soft" onClick={() => setStopping(true)} {...noDrag}>
              <StopCircleIcon size={12} />
              Stop run
            </Button>
          ) : null}
        </>
      )}
      <Menu>
        <Tip label="More">
          <MenuTrigger asChild>
            <IconButton label="Swarm panel actions" size="sm" {...noDrag}>
              <DotsThreeIcon size={16} />
            </IconButton>
          </MenuTrigger>
        </Tip>
        <MenuContent align="end">
          <MenuItem icon={<RowsIcon size={14} />} hint="t" onSelect={() => controller.toggleTimeline(sessionId)}>
            {panel.timelineOpen ? "Hide the Timeline" : "Show the Timeline"}
          </MenuItem>
          <MenuItem
            icon={<SquaresFourIcon size={14} />}
            disabled={!run}
            onSelect={() => {
              for (const entry of entries) if (entry.kind === "phase" && !entry.open) togglePhase(entry.phase.name);
            }}
          >
            Open every phase
          </MenuItem>
          <MenuItem
            icon={<SquaresFourIcon size={14} />}
            disabled={!run}
            onSelect={() => {
              for (const entry of entries) if (entry.kind === "phase" && entry.open) togglePhase(entry.phase.name);
            }}
          >
            Close every phase
          </MenuItem>
          <MenuItem icon={<CopyIcon size={14} />} disabled={!run?.runId} onSelect={() => void navigator.clipboard?.writeText(run?.runId ?? "")}>
            Copy run id
          </MenuItem>
          {run && runLive(run) && !readOnly ? (
            <>
              <MenuSeparator />
              <MenuItem icon={<StopCircleIcon size={14} />} tone="danger" onSelect={() => setStopping(true)}>
                Stop run
              </MenuItem>
            </>
          ) : null}
        </MenuContent>
      </Menu>
      <Tip label="Close the Swarm panel" shortcut={["Esc"]}>
        <IconButton label="Close the Swarm panel" size="sm" onClick={() => controller.toggleSwarmPanel(false)} {...noDrag}>
          <SidebarSimpleIcon size={16} />
        </IconButton>
      </Tip>
    </header>
  );

  const rosterColumn = (className?: string) => (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      {run ? (
        <FilterChips
          counts={counts}
          filter={panel.filter}
          query={panel.query}
          narrow={narrow}
          onFilter={(filter) => controller.setSwarmFilter(sessionId, filter)}
          onQuery={(query) => controller.setSwarmFilter(sessionId, panel.filter, query)}
          searchRef={searchRef}
        />
      ) : null}
      <Roster
        run={run}
        entries={entries}
        focusId={focused}
        finale={finale}
        stale={stale}
        readOnly={readOnly}
        sort={sort}
        confirm={confirm}
        onSort={setSort}
        onFocus={setFocusId}
        onInspect={inspect}
        onTogglePhase={togglePhase}
        onUnfold={(name) => setUnfolded((current) => new Set([...current, name]))}
        onAction={act}
        onConfirm={setConfirm}
        onReview={review}
        register={register}
      />
    </div>
  );

  const inspector = inspected ? (
    <Inspector
      run={inspected.kind === "workflow" ? run : null}
      agent={inspected}
      tab={tab}
      layout={split ? "column" : "full"}
      model={run?.cost?.model ?? sessionModel}
      readOnly={readOnly}
      stale={stale}
      confirm={confirm}
      hasPrevious={step(agentOrder, inspected.id, -1, false) !== null}
      hasNext={step(agentOrder, inspected.id, 1, false) !== null}
      onTab={setTab}
      onBack={() => { const id = inspected.id; inspect(null); moveFocus(id); }}
      onPrevious={() => { const id = step(agentOrder, inspected.id, -1, false); if (id !== null) inspect(id); }}
      onNext={() => { const id = step(agentOrder, inspected.id, 1, false); if (id !== null) inspect(id); }}
      onAction={act}
      onConfirm={setConfirm}
    />
  ) : null;

  let body: ReactNode;
  if (loading) {
    body = (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
        <Spinner size={13} /> Loading agent activity
      </div>
    );
  } else if (!run && tasks.length === 0 && subagents.length === 0) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 pb-[10vh] text-center">
        <SquaresFourIcon size={22} className="text-subtle" />
        <p className="m-0 text-sm font-medium text-fg">No agents in this thread</p>
        <p className="m-0 max-w-[36ch] text-xs text-pretty text-muted">A workflow's agents and background tasks appear here when Muse starts them.</p>
      </div>
    );
  } else if (inspector && !split) {
    body = inspector;
  } else {
    body = (
      <>
        {run ? (
          <div className="shrink-0 border-b border-line px-4 pt-2 pb-2.5">
            <p className="m-0 flex items-center gap-2 truncate text-sm leading-5 whitespace-nowrap text-muted" data-summary="">
              {summaryParts(run).map((part, index) => (
                <span key={index} className="contents">
                  {index > 0 ? <span className="text-subtle">·</span> : null}
                  <span
                    className={cn(
                      "inline-flex items-center gap-1",
                      part.strong && "font-medium text-fg",
                      part.tone === "need" && "font-medium text-warn-text",
                      part.tone === "fail" && "font-medium text-danger-text",
                      part.tone === "quiet" && "font-medium text-muted",
                    )}
                  >
                    {part.tone === "need" ? <ShieldWarningIcon size={12} /> : part.tone === "fail" ? <WarningCircleIcon size={12} /> : part.tone === "quiet" ? <CircleDashedIcon size={12} /> : null}
                    {part.text}
                  </span>
                </span>
              ))}
            </p>
            <KpiStrip run={run} />
          </div>
        ) : null}
        {run ? (
          <Timeline
            run={run}
            width={width - 32}
            collapsed={!panel.timelineOpen}
            selectedId={inspected?.id ?? null}
            closedPhases={closedPhases}
            onLane={inspect}
            onToggle={() => controller.toggleTimeline(sessionId)}
          />
        ) : null}
        {inspector ? (
          <div className="flex min-h-0 flex-1">
            {rosterColumn("border-r border-line")}
            {inspector}
          </div>
        ) : (
          rosterColumn()
        )}
      </>
    );
  }

  const foot = (
    <footer className="flex h-[34px] shrink-0 items-center gap-3 overflow-hidden border-t border-line px-4 text-2xs whitespace-nowrap text-subtle">
      {mode === "inspector" && !split ? (
        <>
          <Hint keys={["esc"]}>back to the run</Hint>
          <Hint keys={["j", "k"]}>next / previous agent</Hint>
          <Hint keys={["r"]}>retry</Hint>
          <Hint keys={["s"]}>skip</Hint>
        </>
      ) : (
        <>
          <Hint keys={["j", "k"]}>move</Hint>
          <Hint keys={["↵"]}>inspect</Hint>
          <Hint keys={["space"]}>peek</Hint>
          <Hint keys={["n"]}>next issue</Hint>
          <Hint keys={["/"]}>filter</Hint>
          <Hint keys={["x"]}>stop</Hint>
          <Hint keys={["esc"]}>{mode === "inspector" ? "back" : "close"}</Hint>
        </>
      )}
    </footer>
  );

  const aside = (
    <aside
      ref={asideRef}
      id="swarm-panel"
      aria-label="Swarm"
      aria-modal="false"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-mode={mode}
      data-layout={split ? "split" : narrow ? "narrow" : "regular"}
      style={style}
      className={cn(
        "@container flex h-full shrink-0 flex-col outline-none",
        overlay ? "overlay absolute inset-y-0 right-0 z-[var(--z-overlay)] bg-raised shadow-pop" : "relative border-l border-line bg-bg",
        narrow && "narrow",
        split && "split",
      )}
    >
      {overlay ? null : <PanelResize />}
      {head}
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      {foot}
      {run ? (
        <Modal
          open={stopping}
          onOpenChange={setStopping}
          title={`Stop the run ${run.name}?`}
          description={`${workingNames(run).length === 0 ? "No agent is working" : `${workingNames(run).length} working ${workingNames(run).length === 1 ? "agent" : "agents"} will be cancelled`}. Finished work stays.`}
        >
          {workingNames(run).length > 0 ? (
            <ul className="mt-3 flex list-none flex-col gap-1 pl-0 text-sm text-fg">
              {workingNames(run).map((name) => (
                <li key={name} className="flex items-center gap-2"><Spinner size={10} className="text-accent-text" />{name}</li>
              ))}
            </ul>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setStopping(false)}>Keep running</Button>
            <Button variant="danger" onClick={stopRun}><StopCircleIcon size={13} />Stop run</Button>
          </div>
        </Modal>
      ) : null}
    </aside>
  );

  if (!overlay) return aside;
  return (
    <div className="relative w-0 shrink-0 self-stretch" data-overlay="">
      <div
        aria-hidden="true"
        onClick={() => controller.toggleSwarmPanel(false)}
        className="absolute inset-y-0 right-0 z-[var(--z-overlay)] bg-[oklch(0.1_0.01_255/0.32)]"
        style={{ width: room }}
      />
      {aside}
    </div>
  );
}

function Hint(props: { keys: string[]; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {props.keys.map((key) => (
        <Kbd key={key} className="h-4 min-w-4 text-[10.5px]">{key}</Kbd>
      ))}
      {props.children}
    </span>
  );
}
