import { Dialog as RDialog } from "radix-ui";
import { InfoIcon, PulseIcon, StopCircleIcon, XCircleIcon } from "../ui/icons.js";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import type { AncillaController } from "../../model/controller.js";
import type { AppState } from "../../model/store.js";
import { activityView, runLive, summaryLine, crewView, type ActivityItemVM, type ActivityVM } from "../../model/crew.js";
import { IconButton, MOD, Shortcut, cn } from "../ui/primitives.js";
import { ActivityItem, XS_GHOST, XS_SECONDARY, activityKey, stoppable, type ActivityRunExtra } from "./ActivityItem.js";

export type ActivityFilter = "all" | "needs" | "running" | "finished";

export interface ActivityDrawerProps {
  readonly open: boolean;
  readonly view: ActivityVM;
  readonly filter: ActivityFilter;
  readonly now: number;
  readonly runs?: Readonly<Record<string, ActivityRunExtra>>;
  readonly stopNames?: { readonly runs: readonly string[]; readonly tasks: readonly string[]; readonly agents?: readonly string[] } | null;
  readonly sidebarWidth?: number;
  onFilter: (filter: ActivityFilter) => void;
  onOpen: (item: ActivityItemVM) => void;
  onStop: (item: ActivityItemVM) => void;
  onStopAll: () => void;
  onClose: () => void;
}

export interface ActivitySection {
  readonly id: Exclude<ActivityFilter, "all">;
  readonly title: string;
  readonly items: ActivityItemVM[];
}

export const FILTERS: readonly { id: ActivityFilter; label: string; key: string }[] = [{ id: "all", label: "All", key: "1" }, { id: "needs", label: "Needs you", key: "2" }, { id: "running", label: "Working", key: "3" }, { id: "finished", label: "Finished today", key: "4" }];

export function sectionsOf(view: ActivityVM): ActivitySection[] {
  const needsGroup: ActivitySection = { id: "needs", title: "Needs you", items: view.needsYou };
  const workingGroup: ActivitySection = { id: "running", title: "Working", items: view.working };
  const finishedGroup: ActivitySection = { id: "finished", title: "Finished today", items: view.finishedToday };
  return [needsGroup, workingGroup, finishedGroup];
}

export function visibleSections(view: ActivityVM, filter: ActivityFilter): ActivitySection[] {
  const catalog = sectionsOf(view);
  if (filter === "all") {
    return catalog.filter((sec) => sec.items.length > 0);
  }
  return catalog.filter((sec) => sec.id === filter);
}

export type DrawerKeyAction = { kind: "move"; delta: 1 | -1 } | { kind: "open" } | { kind: "stop" } | { kind: "filter"; filter: ActivityFilter };

export function drawerKeyAction(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target?: EventTarget | null;
}): DrawerKeyAction | null {
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
  if (hasModifier) return null;

  const targetEl = event.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  const tagIdentifier = targetEl?.tagName ?? "";
  const isInputContext = tagIdentifier === "INPUT" || tagIdentifier === "TEXTAREA" || targetEl?.isContentEditable === true;
  if (isInputContext) return null;

  if (event.key === "j" || event.key === "ArrowDown") {
    const moveForward: DrawerKeyAction = { kind: "move", delta: 1 };
    return moveForward;
  }
  if (event.key === "k" || event.key === "ArrowUp") {
    const moveBackward: DrawerKeyAction = { kind: "move", delta: -1 };
    return moveBackward;
  }
  if (event.key === "Enter") {
    if (tagIdentifier === "BUTTON" || tagIdentifier === "A") return null;
    const openAction: DrawerKeyAction = { kind: "open" };
    return openAction;
  }
  if (event.key === "x") {
    const stopAction: DrawerKeyAction = { kind: "stop" };
    return stopAction;
  }

  const matchingFilter = FILTERS.find((cand) => cand.key === event.key);
  if (matchingFilter) {
    const filterAction: DrawerKeyAction = { kind: "filter", filter: matchingFilter.id };
    return filterAction;
  }
  return null;
}

function stopList(stopAll: NonNullable<ActivityVM["stopAll"]>): string {
  const phrases: string[] = [];
  if (Number(stopAll.runs) > 0) {
    phrases.push(`${stopAll.runs} ${stopAll.runs === 1 ? "run" : "runs"}`);
  }
  if (Number(stopAll.tasks) > 0) {
    phrases.push(`${stopAll.tasks} ${stopAll.tasks === 1 ? "task" : "tasks"}`);
  }
  const nativeCount = stopAll.agents ?? 0;
  if (nativeCount > 0) {
    phrases.push(`${nativeCount} native ${nativeCount === 1 ? "agent" : "agents"}`);
  }
  if (phrases.length === 0) return "";
  if (phrases.length === 1) return phrases[0] as string;
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  const initialParts = phrases.slice(0, -1).join(", ");
  const lastPart = phrases[phrases.length - 1];
  return `${initialParts} and ${lastPart}`;
}

export function stopAllText(stopAll: NonNullable<ActivityVM["stopAll"]>): string {
  const itemsText = stopList(stopAll);
  return `Stop everything stops ${itemsText} in this thread. Approvals stay open.`;
}

export function stopAllQuestion(stopAll: NonNullable<ActivityVM["stopAll"]>): string {
  const itemsText = stopList(stopAll);
  return `Stop everything? Stops ${itemsText}. Approvals stay open.`;
}

function DrawerHeader({ onClose }: { onClose: () => void }) {
  return (
    <header className={cn("flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2.5 pl-4")}>
      <RDialog.Title asChild>
        <h2 className={cn("flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold tracking-[-0.01em]")}>
          <PulseIcon size={16} className={cn("shrink-0 text-subtle")} aria-hidden />
          <span>Activity</span>
          <Shortcut keys={[MOD, "Shift", "A"]} className={cn("gap-1")} />
        </h2>
      </RDialog.Title>
      <RDialog.Description className="sr-only">
        Every request waiting for you, and what runs and finished today in the threads Ancilla follows.
      </RDialog.Description>
      <RDialog.Close asChild>
        <IconButton label="Close" onClick={onClose}><XCircleIcon size={15} /></IconButton>
      </RDialog.Close>
    </header>
  );
}

function DrawerFiltersBar({
  currentFilter,
  counts,
  onSelectFilter,
}: {
  currentFilter: ActivityFilter;
  counts: Record<ActivityFilter, number>;
  onSelectFilter: (f: ActivityFilter) => void;
}) {
  return (
    <div className={cn("flex shrink-0 gap-1.5 px-4 pt-2.5 pb-1")} role="group" aria-label="Show">
      {FILTERS.map((filterItem) => {
        const isActive = filterItem.id === currentFilter;
        const countValue = counts[filterItem.id];
        const buttonClass = cn(
          "inline-flex h-6 shrink-0 items-center gap-[5px] rounded-md px-2 text-xs font-medium whitespace-nowrap",
          isActive ? "bg-active text-fg" : "text-muted shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover hover:text-fg",
        );
        const countClass = cn("tabular-nums", isActive ? "text-muted" : "text-subtle");

        return (
          <button
            key={filterItem.id}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelectFilter(filterItem.id)}
            className={buttonClass}
          >
            {filterItem.id === "needs" && counts.needs > 0 && (
              <span className="size-1.5 rounded-full bg-warn" aria-hidden="true" />
            )}
            {filterItem.label}
            <span className={countClass}>{countValue}</span>
          </button>
        );
      })}
    </div>
  );
}

function DrawerEmptyNotice() {
  return (
    <div className={cn("px-6 py-10 text-center")}>
      <p className="font-display text-2xl text-fg">{"All quiet."}</p>
      <p className="mt-1 text-sm text-subtle">{"Nothing runs and nothing waits for you."}</p>
    </div>
  );
}

function AdvisoryBanner({ text }: { text: string }) {
  return (
    <div className={cn("mx-2 mt-1.5 mb-0.5 flex items-start gap-2 rounded-[10px] bg-sunken px-2.5 py-2 text-xs leading-[18px] text-muted shadow-[inset_0_0_0_1px_var(--border)]")}>
      <InfoIcon size={13} className={cn("mt-0.5 shrink-0 text-subtle")} aria-hidden />
      <span>{text}</span>
    </div>
  );
}

function ConfirmAllFooterContent({
  view,
  stopListLabels,
  onConfirm,
  onCancel,
}: {
  view: ActivityVM;
  stopListLabels: readonly string[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!view.stopAll) return null;
  const questionCopy = stopAllQuestion(view.stopAll);
  return (
    <>
      <span className={cn("min-w-0 flex-1")}>
        <span className="block text-fg">{questionCopy}</span>
        {stopListLabels.length > 0 && (
          <span className="block truncate font-mono text-[11.5px]">{stopListLabels.join(" · ")}</span>
        )}
      </span>
      <button
        type="button"
        onClick={onConfirm}
        className={cn(XS_SECONDARY, "text-danger-text")}
      >
        <StopCircleIcon size={12} />
        <span>Stop everything</span>
      </button>
      <button type="button" className={XS_GHOST} onClick={onCancel}>
        <span>Keep</span>
      </button>
    </>
  );
}

function DefaultFooterContent({
  view,
  onInitiateConfirm,
}: {
  view: ActivityVM;
  onInitiateConfirm: () => void;
}) {
  const footerSummary = view.stopAll ? stopAllText(view.stopAll) : view.foot;
  return (
    <>
      <span className={cn("min-w-0 flex-1")}>{footerSummary}</span>
      {view.stopAll && (
        <button type="button" className={XS_GHOST} onClick={onInitiateConfirm}>
          <StopCircleIcon size={12} />
          <span>Stop everything</span>
        </button>
      )}
    </>
  );
}

export function ActivityDrawer(props: ActivityDrawerProps) {
  const { view, filter, open, now, runs, stopNames, sidebarWidth, onFilter, onOpen, onStop, onStopAll, onClose } = props;
  const activeSections = useMemo(() => visibleSections(view, filter), [view, filter]);
  const flatItems = useMemo(() => activeSections.flatMap((sec) => sec.items), [activeSections]);
  const keysList = useMemo(() => flatItems.map(activityKey), [flatItems]);

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [haltingKey, setHaltingKey] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const rowElementsMap = useRef(new Map<string, HTMLDivElement>());
  const focusRequested = useRef(false);

  const resolvedIndex = Math.max(0, keysList.indexOf(activeKey ?? ""));
  const currentItem = flatItems[resolvedIndex] ?? null;
  const currentRowKey = currentItem ? activityKey(currentItem) : null;

  useEffect(() => {
    if (!focusRequested.current || !currentRowKey) return;
    focusRequested.current = false;
    const targetEl = rowElementsMap.current.get(currentRowKey);
    targetEl?.focus({ preventScroll: true });
    targetEl?.scrollIntoView({ block: "nearest" });
  });

  if (!open) {
    return null;
  }

  const navigateRelative = (delta: 1 | -1) => {
    if (flatItems.length === 0) return;
    const boundedPos = Math.min(flatItems.length - 1, Math.max(0, resolvedIndex + delta));
    setActiveKey(keysList[boundedPos] ?? null);
    focusRequested.current = true;
  };

  const handleContainerKeyDown = (evt: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = drawerKeyAction(evt);
    if (!action) return;
    evt.preventDefault();
    if (action.kind === "move") {
      navigateRelative(action.delta);
    } else if (action.kind === "open") {
      if (currentItem) onOpen(currentItem);
    } else if (action.kind === "stop") {
      if (currentItem && stoppable(currentItem)) setHaltingKey(currentRowKey);
    } else if (action.kind === "filter") {
      onFilter(action.filter);
    }
  };

  const tallyCounts: Record<ActivityFilter, number> = {
    all: (view.needsYou.length + view.working.length) + view.finishedToday.length,
    needs: Number(view.needsYou.length),
    running: Number(view.working.length),
    finished: Number(view.finishedToday.length),
  };

  const stopListLabels = [
    ...(stopNames?.runs ?? []),
    ...(stopNames?.tasks ?? []),
    ...(stopNames?.agents ?? []),
  ];

  const notePlacement = view.note && filter !== "needs" && filter !== "finished"
    ? (activeSections.find((s) => s.id === "running")?.id ?? "end")
    : null;

  const noteElement = view.note ? <AdvisoryBanner text={view.note} /> : null;
  const effectiveWidth = `${sidebarWidth ?? 284}px`;

  const drawerPanelClasses = cn(
    "fixed inset-y-0 left-0 z-[var(--z-modal)] flex w-[min(520px,100vw)] flex-col bg-raised text-fg shadow-pop outline-none transition-[transform,opacity] duration-200 ease-drawer starting:-translate-x-4 starting:opacity-0 motion-reduce:transition-opacity motion-reduce:duration-[120ms] max-[899px]:w-[min(100vw,calc(var(--sb)+200px))]"
  );

  return (
    <RDialog.Root open onOpenChange={(isShown) => (isShown ? undefined : onClose())}>
      <RDialog.Overlay className={cn("overlay-fade fixed inset-0 z-[var(--z-overlay)] bg-[oklch(0.1_0.01_255/0.32)]")} />
      <RDialog.Content
        ref={containerRef}
        aria-modal="true"
        aria-label="Activity"
        tabIndex={-1}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const targetRow = currentRowKey ? rowElementsMap.current.get(currentRowKey) : undefined;
          (targetRow ?? containerRef.current)?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(e) => {
          if (haltingKey !== null || confirmingAll) {
            e.preventDefault();
            setHaltingKey(null);
            setConfirmingAll(false);
          }
        }}
        onKeyDown={handleContainerKeyDown}
        style={{ "--sb": effectiveWidth } as CSSProperties}
        className={drawerPanelClasses}
      >
        <DrawerHeader onClose={onClose} />
        <DrawerFiltersBar
          currentFilter={filter}
          counts={tallyCounts}
          onSelectFilter={onFilter}
        />
        <div className={cn("min-h-0 flex-1 overflow-y-auto px-2 pb-2")}>
          {Boolean(view.empty) ? (
            <DrawerEmptyNotice />
          ) : (
            activeSections.map((section) => {
              const sectionHeaderId = `activity-section-${section.id}`;
              const isSectionEmpty = section.items.length === 0;

              return (
                <section key={section.id} aria-labelledby={sectionHeaderId}>
                  <h3 id={sectionHeaderId} className={cn("flex h-8 items-center gap-2 px-2 pt-2 text-xs font-medium text-subtle")}>
                    <span>{section.title}</span>
                    <span className="tabular-nums">{section.items.length}</span>
                  </h3>
                  {isSectionEmpty ? (
                    <p className="px-2 py-1 text-xs text-subtle">{"None right now."}</p>
                  ) : (
                    <div role="list" className="space-y-0.5">
                      {section.items.map((entryItem) => {
                        const rowKey = activityKey(entryItem);
                        const isRowSelected = rowKey === currentRowKey;
                        const isRowConfirming = rowKey === haltingKey;

                        const triggerItemStop = () => {
                          setActiveKey(rowKey);
                          setHaltingKey(rowKey);
                        };

                        const confirmItemStop = () => {
                          setHaltingKey(null);
                          onStop(entryItem);
                        };

                        return (
                          <ActivityItem
                            key={rowKey}
                            item={entryItem}
                            now={now}
                            extra={runs?.[rowKey]}
                            selected={isRowSelected}
                            confirming={isRowConfirming}
                            rowRef={(domEl) => {
                              if (domEl) rowElementsMap.current.set(rowKey, domEl);
                              else rowElementsMap.current.delete(rowKey);
                            }}
                            onSelect={() => setActiveKey(rowKey)}
                            onOpen={() => onOpen(entryItem)}
                            onStop={triggerItemStop}
                            onConfirmStop={confirmItemStop}
                            onCancelStop={() => setHaltingKey(null)}
                          />
                        );
                      })}
                    </div>
                  )}
                  {notePlacement === section.id && noteElement}
                </section>
              );
            })
          )}
          {!view.empty && notePlacement === "end" && noteElement}
        </div>
        <footer className={cn("flex min-h-11 shrink-0 items-center gap-3 border-t border-line px-4 py-2 text-xs leading-4 text-subtle")}>
          {confirmingAll && view.stopAll ? (
            <ConfirmAllFooterContent
              view={view}
              stopListLabels={stopListLabels}
              onConfirm={() => {
                setConfirmingAll(false);
                onStopAll();
              }}
              onCancel={() => setConfirmingAll(false)}
            />
          ) : (
            <DefaultFooterContent
              view={view}
              onInitiateConfirm={() => setConfirmingAll(true)}
            />
          )}
        </footer>
      </RDialog.Content>
    </RDialog.Root>
  );
}

export interface ActivityModel {
  readonly view: ActivityVM;
  readonly runs: Record<string, ActivityRunExtra>;
  readonly stopNames: { readonly runs: string[]; readonly tasks: string[]; readonly agents?: string[] } | null;
}

function crewOf(state: AppState, sessionId: string, now: number) {
  const currentThread = state.threads[sessionId];
  if (!currentThread) return null;
  return crewView(currentThread.fold, state.sessions[sessionId] ?? null, now, {
    partialHistory: currentThread.truncated,
    pending: state.crew.pending,
    skipped: state.crew.skipped,
    models: (state as AppState).models,
    researchRuns: currentThread.researchRuns,
  });
}

export function activityModel(state: AppState, now: number): ActivityModel {
  const activityData = activityView(state, now);
  const extraRunsMap: Record<string, ActivityRunExtra> = {};
  const activeRuns = [...activityData.working, ...activityData.finishedToday].filter((it) => it.kind === "run");
  const focusedSession = state.route.kind === "thread" ? state.route.sessionId : null;
  const involvedSessions = new Set(activeRuns.map((it) => it.sessionId));
  if (focusedSession !== null && activityData.stopAll) {
    involvedSessions.add(focusedSession);
  }

  let aggregatedStopNames: ActivityModel["stopNames"] = null;

  for (const sessId of involvedSessions) {
    const threadCrew = crewOf(state, sessId, now);
    if (!threadCrew) continue;

    for (const runEntry of threadCrew.runs) {
      const matchedItem = activeRuns.find(
        (cand) => cand.sessionId === sessId && cand.itemId === runEntry.itemId,
      );
      if (matchedItem) {
        const itemKey = activityKey(matchedItem);
        const matrix = runEntry.phases.map((ph) => ph.agents.map((ag) => ag.state));
        extraRunsMap[itemKey] = {
          groups: matrix,
          chips: summaryLine(runEntry).chips,
        };
      }
    }

    if (sessId === focusedSession && activityData.stopAll) {
      const activeStatesSet = new Set(["scheduled", "working", "finishing", "no-update", "waiting-on-you"]);
      const aliveSubagents = threadCrew.subagents
        .filter((sub) => activeStatesSet.has(sub.state))
        .map((sub) => sub.name);

      const runningRunNames = threadCrew.runs
        .filter((r) => runLive(r) && r.runId !== null)
        .map((r) => r.name);

      const activeTaskNames = threadCrew.tasks
        .filter((t) => t.state === "working" || t.state === "no-update" || t.state === "waiting-on-you")
        .map((t) => t.name);

      aggregatedStopNames = {
        runs: runningRunNames,
        tasks: activeTaskNames,
        ...(aliveSubagents.length > 0 ? { agents: aliveSubagents } : {}),
      };
    }
  }

  return { view: activityData, runs: extraRunsMap, stopNames: aggregatedStopNames };
}

export function openActivityItem(controller: AncillaController, item: ActivityItemVM): void {
  const { sessionId, itemId, agentId, kind } = item;
  controller.setActivityOpen(false);
  controller.openThread(sessionId);
  const shouldOpenCard = kind === "run" || kind === "task";
  if (shouldOpenCard) {
    controller.setCardOpen(`crew:${sessionId}`, true);
  }
  const hasAgentTarget = kind !== "request" && agentId !== null;
  if (hasAgentTarget) {
    controller.inspectAgent(sessionId, agentId);
  }
}

export function stopActivityItem(controller: AncillaController, item: ActivityItemVM): void {
  const { sessionId, itemId, agentId, kind } = item;
  if (kind === "run") {
    if (itemId) {
      void controller.stopRun(sessionId, itemId);
    }
    return;
  }
  const targetIdentifier = agentId ?? itemId;
  if (!targetIdentifier) return;

  const currentCrew = crewOf(controller.store.get(), sessionId, Date.now());
  const agentCandidate = currentCrew
    ? [...currentCrew.tasks, ...currentCrew.subagents].find((ag) => ag.id === targetIdentifier)
    : undefined;

  if (agentCandidate) {
    void controller.crewAction(sessionId, agentCandidate, "stop");
    return;
  }
  if (kind === "task") {
    void controller.taskAction(sessionId, "stop", targetIdentifier);
    return;
  }
  void controller.subagentAction(sessionId, "stop", targetIdentifier);
}

export function ActivityDrawerHost() {
  const ctrl = useController();
  const isDrawerOpen = useApp((s) => s.crew.activityOpen);
  const userSidebarWidth = useApp((s) => s.prefs.sidebarWidth);
  const activeAppState = useApp((s) => (isDrawerOpen ? s : null));
  const currentTimestamp = useNow(1000, isDrawerOpen);
  const [activeFilter, setActiveFilter] = useState<ActivityFilter>("all");

  const drawerModel = useMemo(
    () => (activeAppState ? activityModel(activeAppState, currentTimestamp) : null),
    [activeAppState, currentTimestamp],
  );

  if (!isDrawerOpen || !drawerModel) {
    return null;
  }

  const handleStopAllExecution = () => {
    const currentState = ctrl.store.get();
    if (currentState.route.kind === "thread") {
      void ctrl.stopEverything(currentState.route.sessionId);
    }
  };

  return (
    <ActivityDrawer
      open
      view={drawerModel.view}
      runs={drawerModel.runs}
      stopNames={drawerModel.stopNames}
      now={currentTimestamp}
      filter={activeFilter}
      sidebarWidth={userSidebarWidth}
      onFilter={setActiveFilter}
      onOpen={(it) => openActivityItem(ctrl, it)}
      onStop={(it) => stopActivityItem(ctrl, it)}
      onStopAll={handleStopAllExecution}
      onClose={() => ctrl.setActivityOpen(false)}
    />
  );
}
