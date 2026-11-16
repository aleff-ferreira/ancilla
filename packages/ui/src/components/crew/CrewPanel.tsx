import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useSyncExternalStore } from "react";
import {
  ArrowLeftIcon,
  CaretRightIcon,
  CircleDashedIcon,
  CopyIcon,
  DotsThreeIcon,
  RowsIcon,
  ShieldWarningIcon,
  SidebarSimpleIcon,
  SquaresFourIcon,
  StopCircleIcon,
  WarningCircleIcon,
} from "../ui/icons.js";
import { useApp, useController, useNow } from "../../app/context.js";
import { useOverlayDragProps } from "../../app/frame.js";
import { emptyCrewPanel, type CrewFilter } from "../../model/store.js";
import {
  canStopAgent,
  crewBusy,
  crewTurnKey,
  crewView,
  phasesOf,
  runCounts,
  runLive,
  type AgentVM,
  type RunNeedVM,
  type RunVM,
} from "../../model/crew.js";
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
import {
  chipCounts,
  focusOrder,
  isLive,
  issueOrder,
  rosterEntries,
  statusPill,
  summaryParts,
  visibleFilters,
  withPending,
  workingNames,
  type RosterSort,
} from "./panel.js";
import { usePanelKeys, type PanelKeyAction } from "./usePanelKeys.js";

/** Minimum width the transcript thread requires beside docked panel before overlaying. */
export const DOCK_MIN_THREAD = 560;
/** Viewport width threshold where chips wrap and search input collapses. */
export const NARROW_AT = 560;
/** Viewport width threshold where inspector expands as independent column. */
export const SPLIT_AT = 760;
/** Default fallback window width for SSR hydration parity. */
const DEFAULT_FALLBACK_WIDTH = 1440;

const DEFAULT_PANEL_STATE = emptyCrewPanel();
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

function subscribeViewportResize(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

export function useWindowWidth(): number {
  return useSyncExternalStore(
    subscribeViewportResize,
    () => window.innerWidth,
    () => DEFAULT_FALLBACK_WIDTH,
  );
}

/** Determines active run for display: prefers newest running run, falling back to newest completed run. */
export function panelRun(runs: readonly RunVM[]): RunVM | null {
  for (let idx = runs.length - 1; idx >= 0; idx -= 1) {
    const candidate = runs[idx] as RunVM;
    if (runLive(candidate)) {
      return candidate;
    }
  }
  return runs[runs.length - 1] ?? null;
}

function locateAndFocusApproval(requestId: string | null): void {
  if (typeof document === "undefined") {
    return;
  }
  let targetElement: HTMLElement | null = null;
  if (requestId) {
    targetElement = document.querySelector<HTMLElement>(`[data-request-id="${CSS.escape(requestId)}"]`);
  }
  if (!targetElement) {
    targetElement = document.querySelector<HTMLElement>(
      '[data-request-panel], section[aria-label="Approval needed"], section[aria-label="Muse has a question"]',
    );
  }
  if (!targetElement) {
    return;
  }
  targetElement.scrollIntoView({ block: "center" });
  const interactiveElem = targetElement.querySelector<HTMLElement>("button, [tabindex]");
  (interactiveElem ?? targetElement).focus({ preventScroll: true });
}

function computeSteppingTarget(
  sequence: readonly string[],
  activeKey: string | null,
  offset: 1 | -1,
  shouldWrap: boolean,
): string | null {
  if (sequence.length === 0) {
    return null;
  }
  const currentIndex = activeKey === null ? -1 : sequence.indexOf(activeKey);
  if (currentIndex < 0) {
    return offset === 1 ? (sequence[0] as string) : (sequence[sequence.length - 1] as string);
  }
  const targetIndex = currentIndex + offset;
  if (targetIndex < 0 || targetIndex >= sequence.length) {
    return shouldWrap ? (sequence[(targetIndex + sequence.length) % sequence.length] as string) : null;
  }
  return sequence[targetIndex] as string;
}

interface PanelHeaderBarProps {
  isCrumbView: boolean;
  selectedAgent: AgentVM | null;
  activeRun: RunVM | null;
  displayRun: RunVM | null;
  hasTasksOrSubagents: boolean;
  statusBadge: { text: string; tone: string } | null;
  isReadOnly: boolean;
  isTimelineVisible: boolean;
  onNavigateBack: () => void;
  onRequestStopRun: () => void;
  onToggleTimeline: () => void;
  onOpenAllPhases: () => void;
  onCloseAllPhases: () => void;
  onClosePanel: () => void;
}

interface ActionsMenuProps {
  readonly activeRun: RunVM | null;
  readonly isReadOnly: boolean;
  readonly isTimelineVisible: boolean;
  onRequestStopRun: () => void;
  onToggleTimeline: () => void;
  onOpenAllPhases: () => void;
  onCloseAllPhases: () => void;
}

function PanelActionsDropdownMenu({
  activeRun,
  isReadOnly,
  isTimelineVisible,
  onRequestStopRun,
  onToggleTimeline,
  onOpenAllPhases,
  onCloseAllPhases,
}: ActionsMenuProps): ReactElement {
  const disableDragAttrs = useOverlayDragProps("off");
  const canStop = activeRun && runLive(activeRun) && !isReadOnly;

  return (
    <Menu>
      <Tip label="More" side="bottom">
        <MenuTrigger asChild>
          <IconButton
            label="Crew panel actions"
            size="sm"
            className="text-subtle hover:text-fg"
            {...disableDragAttrs}
          >
            <DotsThreeIcon className="shrink-0" size={16} />
          </IconButton>
        </MenuTrigger>
      </Tip>
      <MenuContent align="end">
        <MenuItem
          icon={<RowsIcon size={14} />}
          hint="t"
          onSelect={onToggleTimeline}
        >
          {isTimelineVisible ? "Hide the Timeline" : "Show the Timeline"}
        </MenuItem>
        <MenuItem
          icon={<SquaresFourIcon size={14} />}
          disabled={!activeRun}
          onSelect={onOpenAllPhases}
        >
          <span>Open every phase</span>
        </MenuItem>
        <MenuItem
          icon={<SquaresFourIcon className="shrink-0" size={14} />}
          disabled={!activeRun}
          onSelect={onCloseAllPhases}
        >
          <span>Close every phase</span>
        </MenuItem>
        <MenuItem
          icon={<CopyIcon size={14} />}
          disabled={!activeRun?.runId}
          onSelect={() => void navigator.clipboard?.writeText(activeRun?.runId ?? "")}
        >
          Copy run id
        </MenuItem>
        {canStop ? <MenuSeparator /> : null}
        {canStop ? (
          <MenuItem
            icon={<StopCircleIcon className="text-danger" size={14} />}
            tone="danger"
            onSelect={onRequestStopRun}
          >
            {"Stop run"}
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

function PanelBreadcrumbNav({
  activeRun,
  selectedAgent,
  onNavigateBack,
}: {
  readonly activeRun: RunVM | null;
  readonly selectedAgent: AgentVM;
  onNavigateBack: () => void;
}): ReactElement {
  const disableDragAttrs = useOverlayDragProps("off");
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <Tip label="Back to the run" shortcut={["Esc"]}>
        <IconButton
          label="Back to the run"
          size="sm"
          onClick={onNavigateBack}
          {...disableDragAttrs}
        >
          <ArrowLeftIcon size={15} />
        </IconButton>
      </Tip>
      <nav
        aria-label="Inspector"
        className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-muted whitespace-nowrap"
      >
        <span className="max-w-[190px] truncate text-subtle">
          {activeRun?.name ?? "Crew"}
        </span>
        <CaretRightIcon size={10} className="shrink-0 text-subtle" />
        <b className="truncate font-semibold tracking-[-0.01em] text-fg">
          {selectedAgent.name}
        </b>
      </nav>
    </div>
  );
}

function PanelDefaultHeading({
  displayRun,
  hasTasksOrSubagents,
  statusBadge,
  activeRun,
  isReadOnly,
  onRequestStopRun,
}: {
  readonly displayRun: RunVM | null;
  readonly hasTasksOrSubagents: boolean;
  readonly statusBadge: { text: string; tone: string } | null;
  readonly activeRun: RunVM | null;
  readonly isReadOnly: boolean;
  onRequestStopRun: () => void;
}): ReactElement {
  const disableDragAttrs = useOverlayDragProps("off");
  let mainTitle = "Crew";
  if (displayRun?.name) {
    mainTitle = displayRun.name;
  } else if (hasTasksOrSubagents) {
    mainTitle = "Agents and tasks";
  }
  const canStop = activeRun && runLive(activeRun) && !isReadOnly && !activeRun.stale;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <h2 className="m-0 min-w-0 truncate text-sm font-semibold tracking-[-0.01em]">
        {mainTitle}
      </h2>
      {statusBadge ? (
        <span
          className={cn(
            "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-2xs font-medium",
            statusBadge.tone === "run" && "bg-accent-soft text-accent-text",
            statusBadge.tone === "ok" && "bg-ok-soft text-ok-text",
            statusBadge.tone === "mute" && "bg-active text-muted",
            statusBadge.tone === "fail" && "bg-danger-soft text-danger-text",
          )}
        >
          {statusBadge.text}
        </span>
      ) : null}
      <span className="min-w-0 flex-1" />
      {canStop ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs text-danger-text hover:bg-danger-soft"
          onClick={onRequestStopRun}
          {...disableDragAttrs}
        >
          <StopCircleIcon className="shrink-0" size={12} />
          <span>Stop run</span>
        </Button>
      ) : null}
    </div>
  );
}

function PanelCloseButton({ onClose }: { readonly onClose: () => void }): ReactElement {
  const disableDragAttrs = useOverlayDragProps("off");
  return (
    <Tip label="Close the Crew panel" shortcut={["Esc"]}>
      <IconButton
        label="Close the Crew panel"
        size="sm"
        onClick={onClose}
        {...disableDragAttrs}
      >
        <SidebarSimpleIcon className="shrink-0" size={16} />
      </IconButton>
    </Tip>
  );
}

function PanelHeaderBar({
  isCrumbView,
  selectedAgent,
  activeRun,
  displayRun,
  hasTasksOrSubagents,
  statusBadge,
  isReadOnly,
  isTimelineVisible,
  onNavigateBack,
  onRequestStopRun,
  onToggleTimeline,
  onOpenAllPhases,
  onCloseAllPhases,
  onClosePanel,
}: PanelHeaderBarProps): ReactElement {
  const overlayDragAttrs = useOverlayDragProps();

  return (
    <header
      data-drag-region
      {...overlayDragAttrs}
      className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2.5 pl-4"
    >
      {isCrumbView && selectedAgent ? (
        <PanelBreadcrumbNav
          activeRun={activeRun}
          selectedAgent={selectedAgent}
          onNavigateBack={onNavigateBack}
        />
      ) : (
        <PanelDefaultHeading
          displayRun={displayRun}
          hasTasksOrSubagents={hasTasksOrSubagents}
          statusBadge={statusBadge}
          activeRun={activeRun}
          isReadOnly={isReadOnly}
          onRequestStopRun={onRequestStopRun}
        />
      )}

      <PanelActionsDropdownMenu
        activeRun={activeRun}
        isReadOnly={isReadOnly}
        isTimelineVisible={isTimelineVisible}
        onRequestStopRun={onRequestStopRun}
        onToggleTimeline={onToggleTimeline}
        onOpenAllPhases={onOpenAllPhases}
        onCloseAllPhases={onCloseAllPhases}
      />

      <PanelCloseButton onClose={onClosePanel} />
    </header>
  );
}

interface SummaryKpiBannerProps {
  readonly runViewModel: RunVM;
}

interface PartItemData {
  readonly strong?: boolean;
  readonly tone?: string;
  readonly text: string;
}

function resolvePartToneClassName(tone?: string, isStrong?: boolean): string {
  const classes = ["inline-flex items-center gap-1"];
  if (isStrong) classes.push("font-medium text-fg");
  if (tone === "need") classes.push("font-medium text-warn-text");
  else if (tone === "fail") classes.push("font-medium text-danger-text");
  else if (tone === "quiet") classes.push("font-medium text-muted");
  return classes.join(" ");
}

function renderSummaryPartIcon(tone?: string): ReactElement | null {
  if (tone === "need") return <ShieldWarningIcon size={12} />;
  if (tone === "fail") return <WarningCircleIcon size={12} />;
  if (tone === "quiet") return <CircleDashedIcon size={12} />;
  return null;
}

function SummaryPartSegment({
  part,
  isFirst,
}: {
  readonly part: PartItemData;
  readonly isFirst: boolean;
}): ReactElement {
  const toneClass = resolvePartToneClassName(part.tone, part.strong);
  const toneIcon = renderSummaryPartIcon(part.tone);

  return (
    <span className="contents">
      {!isFirst ? <span className="text-subtle">·</span> : null}
      <span className={toneClass}>
        {toneIcon}
        {part.text}
      </span>
    </span>
  );
}

function SummaryKpiBanner({ runViewModel }: SummaryKpiBannerProps): ReactElement {
  const partsList = summaryParts(runViewModel);

  return (
    <div className="shrink-0 border-b border-line px-4 pt-2 pb-2.5">
      <p
        className="m-0 flex items-center gap-2 truncate text-sm leading-5 whitespace-nowrap text-muted"
        data-summary=""
      >
        {partsList.map((entry, partIdx) => (
          <SummaryPartSegment
            key={partIdx}
            part={entry}
            isFirst={partIdx === 0}
          />
        ))}
      </p>
      <KpiStrip run={runViewModel} />
    </div>
  );
}

function ShortcutKeyHint(props: {
  readonly keys: string[];
  readonly children: ReactNode;
}): ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5">
      {props.keys.map((k) => (
        <Kbd key={k} className="h-4 min-w-4 text-[10.5px]">
          {k}
        </Kbd>
      ))}
      {props.children}
    </span>
  );
}

interface ShortcutFooterProps {
  readonly isInspectorMode: boolean;
  readonly isSplitLayout: boolean;
}

function ShortcutFooterTray({
  isInspectorMode,
  isSplitLayout,
}: ShortcutFooterProps): ReactElement {
  const isNarrowInspector = isInspectorMode && !isSplitLayout;

  return (
    <footer className="flex h-[34px] shrink-0 items-center gap-3 overflow-hidden border-t border-line px-4 text-2xs whitespace-nowrap text-subtle">
      {isNarrowInspector ? (
        <>
          <ShortcutKeyHint keys={["esc"]}>back to the run</ShortcutKeyHint>
          <ShortcutKeyHint keys={["j", "k"]}>next / previous agent</ShortcutKeyHint>
          <ShortcutKeyHint keys={["r"]}>retry</ShortcutKeyHint>
          <ShortcutKeyHint keys={["s"]}>skip</ShortcutKeyHint>
        </>
      ) : (
        <>
          <ShortcutKeyHint keys={["j", "k"]}>move</ShortcutKeyHint>
          <ShortcutKeyHint keys={["↵"]}>inspect</ShortcutKeyHint>
          <ShortcutKeyHint keys={["space"]}>peek</ShortcutKeyHint>
          <ShortcutKeyHint keys={["n"]}>next issue</ShortcutKeyHint>
          <ShortcutKeyHint keys={["/"]}>filter</ShortcutKeyHint>
          <ShortcutKeyHint keys={["x"]}>stop</ShortcutKeyHint>
          <ShortcutKeyHint keys={["esc"]}>
            {isInspectorMode ? "back" : "close"}
          </ShortcutKeyHint>
        </>
      )}
    </footer>
  );
}

interface StopConfirmationDialogProps {
  readonly isOpen: boolean;
  readonly run: RunVM;
  onKeepRunning: () => void;
  onConfirmStop: () => void;
}

function ActiveWorkingAgentsList({
  names,
}: {
  readonly names: readonly string[];
}): ReactElement | null {
  if (names.length === 0) {
    return null;
  }
  return (
    <ul className="mt-3 flex list-none flex-col gap-1 pl-0 text-sm text-fg">
      {names.map((agentName) => (
        <li key={agentName} className="flex items-center gap-2">
          <Spinner className="text-accent-text" size={10} />
          <span>{agentName}</span>
        </li>
      ))}
    </ul>
  );
}

function StopConfirmationDialog({
  isOpen,
  run,
  onKeepRunning,
  onConfirmStop,
}: StopConfirmationDialogProps): ReactElement {
  const activeWorkingNames = workingNames(run);
  const isTurn = run.kind === "turn";
  const modalDialogTitle = isTurn ? "Stop this turn?" : `Stop the run ${run.name}?`;

  let descriptionMsg = "Muse stops working on your prompt. Finished work stays.";
  if (!isTurn) {
    const agentCount = activeWorkingNames.length;
    const workingSuffix = agentCount === 0
      ? "No agent is working"
      : `${agentCount} working ${agentCount === 1 ? "agent" : "agents"} will be cancelled`;
    descriptionMsg = `${workingSuffix}. Finished work stays.`;
  }

  return (
    <Modal
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onKeepRunning();
        }
      }}
      title={modalDialogTitle}
      description={descriptionMsg}
    >
      {!isTurn ? <ActiveWorkingAgentsList names={activeWorkingNames} /> : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onKeepRunning}>
          Keep running
        </Button>
        <Button variant="danger" onClick={onConfirmStop}>
          <StopCircleIcon size={13} />
          {isTurn ? "Stop turn" : "Stop run"}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * CrewPanel: slide-over or docked panel presenting holistic execution telemetry,
 * active roster, timeline, and inspector views for background agents.
 */
export function CrewPanel(props: { sessionId: string }): ReactElement {
  const { sessionId } = props;
  const mainController = useController();

  const currentSession = useApp((state) => state.sessions[sessionId] ?? null);
  const activeThread = useApp((state) => state.threads[sessionId] ?? null);
  const configuredWidth = useApp((state) => state.prefs.crewWidth);
  const sidebarWidthVal = useApp((state) => (state.prefs.sidebarCollapsed ? 0 : state.prefs.sidebarWidth));
  const serverConnection = useApp((state) => state.connection);
  const panelPreferences = useApp((state) => state.crew.panels[sessionId] ?? DEFAULT_PANEL_STATE);
  const pendingActionsMap = useApp((state) => state.crew.pending);
  const skippedList = useApp((state) => state.crew.skipped);
  const availableModels = useApp((state) => state.models);

  const sessionFold = activeThread?.fold ?? null;
  const isFeedStale = serverConnection !== "open" || Boolean(
    sessionFold?.closed ||
    activeThread?.stalled ||
    activeThread?.historySync ||
    activeThread?.readOnly ||
    activeThread?.stale,
  );

  const threadResearchRuns = activeThread?.researchRuns;
  const isSessionBusy = sessionFold ? crewBusy(sessionFold, threadResearchRuns) : false;
  const currentWallTime = useNow(15_000, isSessionBusy && !isFeedStale);
  const designatedModelId = currentSession?.modelId ?? null;

  const crewViewModel = useMemo(
    () => (sessionFold ? crewView(sessionFold, currentSession, currentWallTime, {
      stale: isFeedStale,
      partialHistory: activeThread?.truncated === true,
      pending: pendingActionsMap,
      skipped: skippedList,
      models: availableModels,
      researchRuns: threadResearchRuns,
    }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sessionFold?.agentItems,
      sessionFold?.crew,
      sessionFold?.approvals,
      sessionFold?.userInputs,
      sessionFold?.order,
      sessionFold?.meta.modelId,
      sessionFold?.meta.calls,
      crewTurnKey(sessionFold),
      currentSession?.sessionId,
      designatedModelId,
      currentWallTime,
      isFeedStale,
      activeThread?.truncated,
      pendingActionsMap,
      skippedList,
      availableModels,
      threadResearchRuns,
    ],
  );

  const activeTargetRun = crewViewModel ? panelRun(crewViewModel.runs) : null;
  const resolvedRun = useMemo(
    () => (activeTargetRun ? withPending(activeTargetRun, sessionId, pendingActionsMap) : null),
    [activeTargetRun, sessionId, pendingActionsMap],
  );

  const backgroundTasks = crewViewModel?.tasks ?? [];
  const activeSubagents = crewViewModel?.subagents ?? [];
  const isStillLoading = !activeThread || (
    activeThread.load !== "ready" &&
    activeThread.load !== "error" &&
    activeThread.fold.order.length === 0
  );

  const currentWindowWidth = useWindowWidth();
  const availableRoom = Math.max(0, currentWindowWidth - sidebarWidthVal);
  const isOverlayMode = availableRoom - configuredWidth < DOCK_MIN_THREAD;
  const panelRenderWidth = isOverlayMode
    ? Math.max(320, Math.min(configuredWidth, availableRoom))
    : configuredWidth;
  const isNarrowLayout = panelRenderWidth <= NARROW_AT;
  const isSplitLayout = panelRenderWidth >= SPLIT_AT;

  const [activeFocusedId, setActiveFocusedId] = useState<string | null>(null);
  const [activeSortOrder, setActiveSortOrder] = useState<RosterSort>("time");
  const [activeInspectorTab, setActiveInspectorTab] = useState<InspectorTab>("overview");
  const [pendingConfirm, setPendingConfirm] = useState<RowConfirm | null>(null);
  const [isStopModalOpen, setIsStopModalOpen] = useState(false);
  const [unfoldedPhasesSet, setUnfoldedPhasesSet] = useState<ReadonlySet<string>>(EMPTY_STRING_SET);
  const [activePeekId, setActivePeekId] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const panelAsideRef = useRef<HTMLElement>(null);
  const registeredRowElements = useRef(new Map<string, HTMLElement>());
  const scheduledFocusIdRef = useRef<string | null>(null);

  const rosterEntryList = useMemo(
    () => rosterEntries(resolvedRun, {
      filter: panelPreferences.filter,
      query: panelPreferences.query,
      openPhases: panelPreferences.openPhases,
      sort: activeSortOrder,
      unfolded: unfoldedPhasesSet,
      tasks: backgroundTasks,
      subagents: activeSubagents,
    }),
    [
      resolvedRun,
      panelPreferences.filter,
      panelPreferences.query,
      panelPreferences.openPhases,
      activeSortOrder,
      unfoldedPhasesSet,
      backgroundTasks,
      activeSubagents,
    ],
  );

  const fullFocusOrder = useMemo(() => focusOrder(rosterEntryList), [rosterEntryList]);
  const agentFocusOrder = useMemo(() => focusOrder(rosterEntryList, true), [rosterEntryList]);
  const issueSequence = useMemo(() => issueOrder(resolvedRun, rosterEntryList), [resolvedRun, rosterEntryList]);

  const consolidatedAgentList = useMemo(
    () => [...(resolvedRun?.agents ?? []), ...backgroundTasks, ...activeSubagents],
    [resolvedRun, backgroundTasks, activeSubagents],
  );

  const syntheticDisplayRun = useMemo(() => {
    if (!resolvedRun || backgroundTasks.length + activeSubagents.length === 0) {
      return resolvedRun;
    }
    const derivedPhases = phasesOf(consolidatedAgentList);
    const hasLiveAgents = runLive(resolvedRun) || consolidatedAgentList.some(isLive);
    const earliestStart = consolidatedAgentList.reduce<number | null>(
      (acc, ag) => (ag.startedAt === null ? acc : acc === null ? ag.startedAt : Math.min(acc, ag.startedAt)),
      resolvedRun.startedAt,
    );
    const latestEnd = hasLiveAgents ? null : consolidatedAgentList.reduce<number | null>(
      (acc, ag) => (ag.endedAt === null ? acc : Math.max(acc ?? 0, ag.endedAt)),
      resolvedRun.endedAt,
    );
    const syntheticName = !runLive(resolvedRun) && hasLiveAgents ? "Agents and tasks" : resolvedRun.name;
    const computedElapsed = earliestStart === null || (!hasLiveAgents && latestEnd === null)
      ? null
      : Math.max(0, (latestEnd ?? resolvedRun.clockAt) - earliestStart);

    return {
      ...resolvedRun,
      name: syntheticName,
      agents: consolidatedAgentList,
      phases: derivedPhases,
      counts: runCounts({ phases: derivedPhases }),
      status: hasLiveAgents ? ("running" as const) : resolvedRun.status,
      startedAt: earliestStart,
      endedAt: latestEnd,
      elapsedMs: computedElapsed,
    };
  }, [resolvedRun, backgroundTasks, activeSubagents, consolidatedAgentList]);

  const currentlyInspectedAgent = panelPreferences.mode === "inspector" && panelPreferences.inspectId !== null
    ? consolidatedAgentList.find((ag) => ag.id === panelPreferences.inspectId) ?? null
    : null;

  const currentDisplayMode = currentlyInspectedAgent ? "inspector" : "roster";
  const effectiveFocusTarget = activeFocusedId !== null && fullFocusOrder.includes(activeFocusedId)
    ? activeFocusedId
    : (fullFocusOrder[0] ?? null);

  const filterMetricsCounts = useMemo(
    () => chipCounts({
      counts: runCounts({ phases: phasesOf(consolidatedAgentList) }),
      runNeeds: resolvedRun?.runNeeds ?? [],
    }),
    [consolidatedAgentList, resolvedRun],
  );

  const closedPhaseNamesSet = useMemo(
    () => new Set(
      rosterEntryList
        .filter((entry) => entry.kind === "phase" && !entry.open)
        .map((entry) => (entry.kind === "phase" ? entry.phase.name : "")),
    ),
    [rosterEntryList],
  );

  const isThreadReadOnly = Boolean(activeThread?.readOnly);
  const isExecutionFinalized = resolvedRun !== null && !runLive(resolvedRun);

  useEffect(() => {
    const targetId = scheduledFocusIdRef.current;
    if (targetId === null) {
      return;
    }
    const matchingElement = registeredRowElements.current.get(targetId);
    if (matchingElement) {
      scheduledFocusIdRef.current = null;
      matchingElement.focus({ preventScroll: true });
      matchingElement.scrollIntoView?.({ block: "nearest" });
    }
  });

  useEffect(() => {
    if (activePeekId !== null && activePeekId !== effectiveFocusTarget) {
      setActivePeekId(null);
    }
  }, [activePeekId, effectiveFocusTarget]);

  useEffect(() => {
    const currentActiveElement = typeof document !== "undefined" ? document.activeElement : null;
    if (currentActiveElement instanceof HTMLElement && !isTyping(currentActiveElement)) {
      panelAsideRef.current?.focus({ preventScroll: true });
    }
    return () => {
      if (currentActiveElement instanceof HTMLElement && document.contains(currentActiveElement)) {
        currentActiveElement.focus({ preventScroll: true });
      }
    };
  }, []);

  const changeFocusRow = useCallback((rowId: string | null) => {
    if (rowId === null) {
      return;
    }
    scheduledFocusIdRef.current = rowId;
    setActiveFocusedId(rowId);
  }, []);

  const registerRowRef = useCallback((rowId: string, elem: HTMLElement | null) => {
    if (elem) {
      registeredRowElements.current.set(rowId, elem);
    } else {
      registeredRowElements.current.delete(rowId);
    }
  }, []);

  const openInspectorForAgent = useCallback(
    (agentId: string | null) => {
      setPendingConfirm(null);
      setActivePeekId(null);
      mainController.inspectAgent(sessionId, agentId);
      if (agentId !== null) {
        setActiveFocusedId(agentId);
      }
    },
    [mainController, sessionId],
  );

  const dispatchRowAction = useCallback(
    (agent: AgentVM, action: RowAction) => {
      if (action === "inspect") {
        openInspectorForAgent(agent.id);
      } else if (action === "review") {
        locateAndFocusApproval(agent.needs?.requestId ?? null);
      } else {
        void mainController.crewAction(sessionId, agent, action);
      }
    },
    [mainController, openInspectorForAgent, sessionId],
  );

  const dispatchNeedReview = useCallback((need: RunNeedVM) => {
    locateAndFocusApproval(need.requestId);
  }, []);

  const dispatchTogglePhase = useCallback(
    (phaseName: string) => {
      mainController.togglePhase(sessionId, phaseName);
    },
    [mainController, sessionId],
  );

  const resolveTargetAgent = (): AgentVM | null => {
    return currentlyInspectedAgent ?? consolidatedAgentList.find((ag) => ag.id === effectiveFocusTarget) ?? null;
  };

  const resolvePhaseOfCurrentFocus = (): string | null => {
    const entry = rosterEntryList.find((cand) => cand.id === effectiveFocusTarget);
    if (!entry) {
      return resolvedRun?.currentPhase ?? null;
    }
    return entry.kind === "phase" ? entry.phase.name : entry.kind === "agent" ? entry.phase : null;
  };

  const handleKeyboardAction = useCallback(
    (action: PanelKeyAction, rawEvent: KeyboardEvent<HTMLElement>): boolean => {
      void rawEvent;
      switch (action) {
        case "next":
        case "previous": {
          const stepDelta = action === "next" ? 1 : -1;
          if (currentlyInspectedAgent) {
            const nextAgentId = computeSteppingTarget(agentFocusOrder, currentlyInspectedAgent.id, stepDelta, false);
            if (nextAgentId !== null) {
              openInspectorForAgent(nextAgentId);
            }
            if (nextAgentId !== null && isSplitLayout) {
              changeFocusRow(nextAgentId);
            }
            return true;
          }
          changeFocusRow(computeSteppingTarget(fullFocusOrder, effectiveFocusTarget, stepDelta, false));
          return true;
        }
        case "inspect":
        case "peek": {
          const entry = rosterEntryList.find((cand) => cand.id === effectiveFocusTarget);
          if (!entry) {
            return false;
          }
          if (entry.kind === "phase") {
            dispatchTogglePhase(entry.phase.name);
          } else if (entry.kind === "need") {
            dispatchNeedReview(entry.need);
          } else if (entry.kind === "agent" && action === "peek") {
            setActivePeekId((cur) => (cur === entry.id ? null : entry.id));
          } else if (entry.kind === "agent") {
            openInspectorForAgent(entry.id);
          }
          return true;
        }
        case "next-issue":
        case "previous-issue": {
          const startingId = currentlyInspectedAgent ? currentlyInspectedAgent.id : effectiveFocusTarget;
          const nextIssueTarget = computeSteppingTarget(issueSequence, startingId, action === "next-issue" ? 1 : -1, true);
          if (nextIssueTarget === null) {
            return false;
          }
          if (currentlyInspectedAgent && !nextIssueTarget.startsWith("need:")) {
            openInspectorForAgent(nextIssueTarget);
          }
          changeFocusRow(nextIssueTarget);
          return true;
        }
        case "find":
          if (currentDisplayMode === "inspector" && !isSplitLayout) {
            openInspectorForAgent(null);
          }
          window.setTimeout(() => searchInputRef.current?.focus(), 0);
          return true;
        case "cycle-filter": {
          const filterOptions = visibleFilters(filterMetricsCounts);
          const nextFilter = filterOptions[(filterOptions.indexOf(panelPreferences.filter) + 1) % filterOptions.length] as CrewFilter;
          mainController.setCrewFilter(sessionId, nextFilter);
          return true;
        }
        case "timeline":
          mainController.toggleTimeline(sessionId);
          return true;
        case "collapse-phase":
        case "expand-phase": {
          const phaseName = resolvePhaseOfCurrentFocus();
          if (phaseName === null) {
            return false;
          }
          const phaseEntry = rosterEntryList.find((cand) => cand.kind === "phase" && cand.phase.name === phaseName);
          const isOpen = phaseEntry?.kind === "phase" ? phaseEntry.open : false;
          if ((action === "collapse-phase") === isOpen) {
            dispatchTogglePhase(phaseName);
          }
          if (action === "collapse-phase") {
            changeFocusRow(`phase:${phaseName}`);
          }
          return true;
        }
        case "retry": {
          const target = resolveTargetAgent();
          if (!target || target.state !== "failed" || target.kind !== "workflow" || isThreadReadOnly) {
            return false;
          }
          dispatchRowAction(target, "retry");
          return true;
        }
        case "skip": {
          const target = resolveTargetAgent();
          if (
            !target ||
            target.kind !== "workflow" ||
            target.state === "done" ||
            target.state === "skipped" ||
            target.state === "unknown" ||
            target.state === "planned" ||
            isThreadReadOnly
          ) {
            return false;
          }
          setPendingConfirm({ kind: "skip", id: target.id });
          return true;
        }
        case "stop": {
          const target = resolveTargetAgent();
          if (
            target &&
            canStopAgent(target) &&
            (target.state === "working" ||
              target.state === "finishing" ||
              target.state === "no-update" ||
              target.state === "scheduled" ||
              target.state === "waiting-on-you") &&
            !isThreadReadOnly
          ) {
            setPendingConfirm({ kind: "stop", id: target.id });
            return true;
          }
          if (resolvedRun && runLive(resolvedRun) && !isThreadReadOnly) {
            setIsStopModalOpen(true);
            return true;
          }
          return false;
        }
        case "tab-overview":
          setActiveInspectorTab("overview");
          return true;
        case "tab-lifecycle":
          setActiveInspectorTab("lifecycle");
          return true;
        case "tab-result":
          setActiveInspectorTab("result");
          return true;
        case "back":
          if (activePeekId !== null) {
            setActivePeekId(null);
            return true;
          }
          if (pendingConfirm) {
            setPendingConfirm(null);
            return true;
          }
          if (currentlyInspectedAgent) {
            const preservedId = currentlyInspectedAgent.id;
            openInspectorForAgent(null);
            changeFocusRow(preservedId);
            return true;
          }
          mainController.toggleCrewPanel(false);
          return true;
      }
    },
    [
      agentFocusOrder,
      changeFocusRow,
      consolidatedAgentList,
      currentDisplayMode,
      currentlyInspectedAgent,
      dispatchNeedReview,
      dispatchRowAction,
      dispatchTogglePhase,
      effectiveFocusTarget,
      filterMetricsCounts,
      fullFocusOrder,
      isSplitLayout,
      isThreadReadOnly,
      issueSequence,
      mainController,
      openInspectorForAgent,
      panelPreferences.filter,
      pendingConfirm,
      activePeekId,
      resolvedRun,
      rosterEntryList,
      sessionId,
    ],
  );

  const onPanelKeyDown = usePanelKeys(currentDisplayMode, handleKeyboardAction);

  const panelRootStyle = {
    "--pane-bg": isOverlayMode ? "var(--bg-raised)" : "var(--bg)",
    width: panelRenderWidth,
  } as CSSProperties;

  const currentStatusBadge = syntheticDisplayRun ? statusPill(syntheticDisplayRun) : null;
  const isCrumbViewActive = currentDisplayMode === "inspector" && !isSplitLayout && currentlyInspectedAgent !== null;

  const handleStopRunConfirmation = () => {
    if (!resolvedRun) {
      return;
    }
    setIsStopModalOpen(false);
    void mainController.stopRun(sessionId, resolvedRun.itemId);
  };

  const headerComponent = (
    <PanelHeaderBar
      isCrumbView={isCrumbViewActive}
      selectedAgent={currentlyInspectedAgent}
      activeRun={resolvedRun}
      displayRun={syntheticDisplayRun}
      hasTasksOrSubagents={backgroundTasks.length > 0 || activeSubagents.length > 0}
      statusBadge={currentStatusBadge}
      isReadOnly={isThreadReadOnly}
      isTimelineVisible={Boolean(panelPreferences.timelineOpen)}
      onNavigateBack={() => {
        if (currentlyInspectedAgent) {
          const id = currentlyInspectedAgent.id;
          openInspectorForAgent(null);
          changeFocusRow(id);
        }
      }}
      onRequestStopRun={() => setIsStopModalOpen(true)}
      onToggleTimeline={() => mainController.toggleTimeline(sessionId)}
      onOpenAllPhases={() => {
        for (const entry of rosterEntryList) {
          if (entry.kind === "phase" && !entry.open) {
            dispatchTogglePhase(entry.phase.name);
          }
        }
      }}
      onCloseAllPhases={() => {
        for (const entry of rosterEntryList) {
          if (entry.kind === "phase" && entry.open) {
            dispatchTogglePhase(entry.phase.name);
          }
        }
      }}
      onClosePanel={() => mainController.toggleCrewPanel(false)}
    />
  );

  const renderRosterColumn = (additionalClassName?: string) => (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", additionalClassName)}>
      {consolidatedAgentList.length > 0 ? (
        <FilterChips
          counts={filterMetricsCounts}
          filter={panelPreferences.filter}
          query={panelPreferences.query}
          narrow={isNarrowLayout}
          onFilter={(f) => mainController.setCrewFilter(sessionId, f)}
          onQuery={(q) => mainController.setCrewFilter(sessionId, panelPreferences.filter, q)}
          searchRef={searchInputRef}
        />
      ) : null}
      <Roster
        run={resolvedRun}
        entries={rosterEntryList}
        focusId={effectiveFocusTarget}
        peekId={activePeekId}
        finale={isExecutionFinalized}
        stale={isFeedStale}
        readOnly={isThreadReadOnly}
        sort={activeSortOrder}
        confirm={pendingConfirm}
        onSort={setActiveSortOrder}
        onFocus={setActiveFocusedId}
        onInspect={openInspectorForAgent}
        onTogglePhase={dispatchTogglePhase}
        onUnfold={(phaseName) => setUnfoldedPhasesSet((cur) => new Set([...cur, phaseName]))}
        onAction={dispatchRowAction}
        onConfirm={setPendingConfirm}
        onReview={dispatchNeedReview}
        register={registerRowRef}
      />
    </div>
  );

  const inspectorComponent = currentlyInspectedAgent ? (
    <Inspector
      run={currentlyInspectedAgent.kind === "workflow" || currentlyInspectedAgent.kind === "research" ? resolvedRun : null}
      agent={currentlyInspectedAgent}
      tab={activeInspectorTab}
      layout={isSplitLayout ? "column" : "full"}
      model={resolvedRun?.cost?.model ?? designatedModelId}
      readOnly={isThreadReadOnly}
      stale={isFeedStale}
      confirm={pendingConfirm}
      hasPrevious={computeSteppingTarget(agentFocusOrder, currentlyInspectedAgent.id, -1, false) !== null}
      hasNext={computeSteppingTarget(agentFocusOrder, currentlyInspectedAgent.id, 1, false) !== null}
      onTab={setActiveInspectorTab}
      onBack={() => {
        const agId = currentlyInspectedAgent.id;
        openInspectorForAgent(null);
        changeFocusRow(agId);
      }}
      onPrevious={() => {
        const prevId = computeSteppingTarget(agentFocusOrder, currentlyInspectedAgent.id, -1, false);
        if (prevId !== null) {
          openInspectorForAgent(prevId);
        }
      }}
      onNext={() => {
        const nextId = computeSteppingTarget(agentFocusOrder, currentlyInspectedAgent.id, 1, false);
        if (nextId !== null) {
          openInspectorForAgent(nextId);
        }
      }}
      onAction={dispatchRowAction}
      onConfirm={setPendingConfirm}
    />
  ) : null;

  let bodyContent: ReactNode;
  if (isStillLoading) {
    bodyContent = (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
        <Spinner size={13} /> Loading agent activity
      </div>
    );
  } else if (!resolvedRun && backgroundTasks.length === 0 && activeSubagents.length === 0) {
    bodyContent = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 pb-[10vh] text-center">
        <SquaresFourIcon size={22} className="text-subtle" />
        <p className="m-0 text-sm font-medium text-fg">No agents in this thread</p>
        <p className="m-0 max-w-[36ch] text-xs text-pretty text-muted">
          Send a prompt to follow Muse, its tools, delegated agents and background tasks here.
        </p>
      </div>
    );
  } else if (inspectorComponent && !isSplitLayout) {
    bodyContent = inspectorComponent;
  } else {
    bodyContent = (
      <>
        {syntheticDisplayRun ? <SummaryKpiBanner runViewModel={syntheticDisplayRun} /> : null}
        {syntheticDisplayRun ? (
          <Timeline
            run={syntheticDisplayRun}
            width={panelRenderWidth - 32}
            collapsed={!panelPreferences.timelineOpen}
            selectedId={currentlyInspectedAgent?.id ?? null}
            closedPhases={closedPhaseNamesSet}
            onLane={openInspectorForAgent}
            onToggle={() => mainController.toggleTimeline(sessionId)}
          />
        ) : null}
        {inspectorComponent ? (
          <div className="flex min-h-0 flex-1">
            {renderRosterColumn("border-r border-line")}
            {inspectorComponent}
          </div>
        ) : (
          renderRosterColumn()
        )}
      </>
    );
  }

  const footerComponent = (
    <ShortcutFooterTray
      isInspectorMode={currentDisplayMode === "inspector"}
      isSplitLayout={isSplitLayout}
    />
  );

  const panelAsideElement = (
    <aside
      ref={panelAsideRef}
      id="crew-panel"
      aria-label="Crew"
      aria-modal="false"
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      data-mode={currentDisplayMode}
      data-layout={isSplitLayout ? "split" : isNarrowLayout ? "narrow" : "regular"}
      style={panelRootStyle}
      className={cn(
        "@container flex h-full shrink-0 flex-col outline-none",
        isOverlayMode
          ? "overlay absolute inset-y-0 right-0 z-[var(--z-overlay)] bg-raised shadow-pop"
          : "relative border-l border-line bg-bg",
        isNarrowLayout && "narrow",
        isSplitLayout && "split",
      )}
    >
      {isOverlayMode ? null : <PanelResize />}
      {headerComponent}
      <div className="flex min-h-0 flex-1 flex-col">{bodyContent}</div>
      {footerComponent}
      {resolvedRun ? (
        <StopConfirmationDialog
          isOpen={isStopModalOpen}
          run={resolvedRun}
          onKeepRunning={() => setIsStopModalOpen(false)}
          onConfirmStop={handleStopRunConfirmation}
        />
      ) : null}
    </aside>
  );

  if (!isOverlayMode) {
    return panelAsideElement;
  }

  return (
    <div className="relative w-0 shrink-0 self-stretch" data-overlay="">
      <div
        aria-hidden="true"
        onClick={() => mainController.toggleCrewPanel(false)}
        className="absolute inset-y-0 right-0 z-[var(--z-overlay)] bg-[oklch(0.1_0.01_255/0.32)]"
        style={{ width: availableRoom }}
      />
      {panelAsideElement}
    </div>
  );
}
