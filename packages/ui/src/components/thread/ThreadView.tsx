function StopTurnHeaderButton({ sessionId }: { sessionId: string }) {
  const ctrl = useController();
  return ( <Tip label="Stop the turn" shortcut={["Esc"]}>
      <IconButton label="Stop the turn" onClick={() => void ctrl.stop(sessionId)}>
        <SquareIcon weight="fill" size={11} /></IconButton></Tip>
  );
}

function GitBranchHeaderChip({ branch }: { branch: string | null }) {
  if (!branch) return null;
  return ( <span className="hidden min-w-0 items-center gap-1 text-xs text-subtle lg:flex">
      <GitBranchIcon size={12} className="shrink-0" /><span className="truncate font-mono text-2xs">{branch}</span>
    </span>
  );
}

import { ArchiveIcon, ArrowsInIcon, CodeIcon, CopyIcon, DotsThreeIcon, FolderIcon, FolderOpenIcon, GitBranchIcon, GlobeIcon, LockIcon, NotePencilIcon, PencilSimpleIcon, ShieldSlashIcon, SquareHalfBottomIcon, SquareIcon, TreeStructureIcon } from "../ui/icons.js";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import { CaptionSpacer, useOverlayDragProps } from "../../app/frame.js";
import { basename } from "../../model/format.js";
import { goalView } from "../../model/goal.js";
import { taskPlanItems, taskPlanView } from "../../model/taskPlan.js";
import { agentFeedRecovered, agentNumbers, markAgentFeed, type AgentFeedMark } from "../../model/agents.js";
import { runLive, crewBusy, crewTurnKey, crewView, type CrewVM } from "../../model/crew.js";
import type { ThreadState } from "../../model/store.js";
import type { SessionSummary } from "../../types.js";
import { SidebarToggle, TrafficLightSpacer } from "../chrome.js";
import { Composer, ComposerFooter } from "../composer/Composer.js";
import { TelemetryPills } from "../composer/TelemetryPills.js";
import { ApprovalPanel, PlanPanel, QuestionPanel, QueuedList, ReadOnlyNotice, StalledNotice } from "../requests/Requests.js";
import { GoalPanel } from "./GoalPanel.js";
import { revealLabel } from "../sidebar/Sidebar.js";
import { NeedsYouChip, CrewStatus, CrewToggle, focusRequestPanel, headerRun, staleAge, useLanded } from "../crew/HeaderChips.js";
import { CrewDockCard, primaryRun } from "../crew/CrewCard.js";
import { ThreadPresence } from "../assistant/companion/ThreadPresence.js";
import { planPlace } from "../../model/runCard.js";
import { CrewPanel } from "../crew/CrewPanel.js";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tip } from "../ui/overlays.js";
import { IconButton, MOD } from "../ui/primitives.js";
import { FilesPanel } from "../files/FilesPanel.js";
import { BrowserPanel } from "../browser/BrowserPanel.js";
import { Transcript } from "./Transcript.js";

/** Clock tick interval for crew freshness telemetry. */
const REFRESH_AGE_INTERVAL_MS = 15_000;

/** Derives synchronized timeline and crew view model for a thread. */
function useThreadViewState(targetSessionId: string) {
  const currentSession = useApp((st) => st.sessions[targetSessionId] ?? null);
  const currentThread = useApp((st) => st.threads[targetSessionId] ?? null);
  const activeSide = useApp((st) => st.prefs.sidePanel);
  const connState = useApp((st) => st.connection);
  const modelCatalog = useApp((st) => st.models);
  const activePending = useApp((st) => st.crew.pending);
  const activeSkipped = useApp((st) => st.crew.skipped);

  const activeFold = currentThread?.fold ?? null;
  const feedItems = activeFold ? (activeFold.agentItems ?? activeFold.items) : null;
  const isFeedOffline = currentSession?.live?.viewHealth?.status === "unavailable";

  const [feedMarker, setFeedMarker] = useState<AgentFeedMark | null>(null);
  const evaluatedMark = markAgentFeed(feedMarker, targetSessionId, isFeedOffline, currentThread?.load ?? "idle", feedItems);

  if (evaluatedMark !== feedMarker) {
    setFeedMarker(evaluatedMark);
  }

  const threadResearchRuns = currentThread?.researchRuns;
  const isAgentWorkBusy = activeFold ? crewBusy(activeFold, threadResearchRuns) : false;
  const currentTimestamp = useNow(REFRESH_AGE_INTERVAL_MS, isAgentWorkBusy);

  const isFeedStale =
    connState !== "open" ||
    Boolean(
      currentThread?.fold.closed ||
        currentThread?.stalled ||
        currentThread?.historySync ||
        currentThread?.readOnly ||
        currentThread?.stale,
    ) ||
    (isFeedOffline &&
      !agentFeedRecovered(evaluatedMark, targetSessionId, feedItems, currentThread?.fold.activeTurnId === null));

  const hasLoadedHistory = !currentThread || currentThread.fold.order.length > 0 || currentThread.load === "ready";

  const evaluatedCrew = useMemo<CrewVM | null>(() => {
    if (!activeFold || !hasLoadedHistory) return null;
    return crewView(activeFold, currentSession, currentTimestamp, {
      stale: isFeedStale,
      partialHistory: currentThread?.truncated,
      pending: activePending,
      skipped: activeSkipped,
      models: modelCatalog,
      numbers: agentNumbers(targetSessionId),
      researchRuns: threadResearchRuns,
    });
  }, [
    feedItems,
    activeFold?.order,
    activeFold?.approvals,
    activeFold?.userInputs,
    activeFold?.crew,
    activeFold?.meta.calls,
    crewTurnKey(activeFold),
    currentSession,
    currentTimestamp,
    isFeedStale,
    currentThread?.truncated,
    activePending,
    activeSkipped,
    modelCatalog,
    hasLoadedHistory,
    targetSessionId,
    threadResearchRuns,
  ]);

  const isTurnRunning = currentThread
    ? currentThread.fold.activeTurnId !== null
    : Boolean(currentSession?.live?.activeTurnId);

  return {
    session: currentSession,
    thread: currentThread,
    sidePanel: activeSide,
    fold: activeFold,
    busy: isAgentWorkBusy,
    crew: evaluatedCrew,
    crewStale: isFeedStale,
    running: isTurnRunning,
  };
}

export function ThreadView(props: { sessionId: string }) {
  const { session, thread, sidePanel, fold, busy, crew, crewStale, running } = useThreadViewState(props.sessionId);

  if (!session) return <MissingThread />;

  return ( <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <ThreadHeader session={session} thread={thread} running={running} busy={busy} crew={crew} crewStale={crewStale} />
      <div className="flex min-h-0 flex-1">
        <div className="@container flex min-w-0 flex-1 flex-col">
          {thread ? <Transcript sessionId={props.sessionId} thread={thread} /> : <div className="min-h-0 flex-1" />}
          <Dock session={session} thread={thread} running={running} crew={crew} crewStale={crewStale} />
        </div>
        {sidePanel === "crew" ? <CrewPanel sessionId={props.sessionId} />
          : sidePanel === "files" ? <FilesPanel sessionId={props.sessionId} cwd={session.cwd} />
          : sidePanel === "browser" ? <BrowserPanel /> : null}
      </div>
    </div>
  );
}

function TitleField(props: { initial: string; onDone: (value: string | null) => void }) {
  const [val, setVal] = useState(props.initial);
  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") props.onDone(val.trim() || null);
    else if (e.key === "Escape") props.onDone(null);
  };

  return ( <input
      autoFocus
      type="text"
      value={val}
      onChange={(e) => setVal(e.currentTarget.value)}
      onKeyDown={handleKey}
      onBlur={() => props.onDone(val.trim() || null)}
      className="h-6 rounded bg-sunken px-1.5 font-medium text-xs text-fg outline-none focus-visible:ring-1 focus-visible:ring-focus" />
  );
}

function ProjectFolderBadge({ cwd }: { cwd: string }) {
  const ctrl = useController();
  return ( <Menu>
      <MenuTrigger asChild>
        <button type="button" title={cwd} className="flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-subtle transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover">
          <FolderIcon size={12} className="shrink-0" /><span className="truncate">{basename(cwd)}</span>
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem icon={<NotePencilIcon size={14} />} onSelect={() => ctrl.newThread(cwd)}>
          New thread in {basename(cwd)}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function SandboxDisabledAlert() {
  const alertTip = "This thread started while sandboxing was switched off, so its shells run unconfined";
  return <Tip label={alertTip}><span className="flex shrink-0 items-center gap-1.5 px-1 text-xs font-medium text-warn-text"><ShieldSlashIcon size={12} aria-hidden="true" /><span className="sr-only">Sandbox off</span><span aria-hidden="true" className="@max-[420px]:hidden">Sandbox off</span></span></Tip>;
}

function ThreadLockBadge() {
  return <span className="flex shrink-0 items-center gap-1.5 px-1 text-xs text-subtle"><LockIcon size={12} /><span className="@max-[420px]:hidden">Read-only</span></span>;
}

function OpenInEditorButton({ cwd }: { cwd: string | null }) {
  const ctrl = useController();
  if (!cwd) return null;
  return <span className="@max-[360px]:hidden"><Tip label="Open in VS Code"><IconButton label="Open in VS Code" onClick={() => void ctrl.openFolder(cwd, "editor")}><CodeIcon size={15} /></IconButton></Tip></span>;
}

function ThreadHeaderMenu({
  sessionId,
  cwd,
  onRename,
  isReadOnly,
}: {
  sessionId: string;
  cwd: string | null;
  onRename: () => void;
  isReadOnly: boolean;
}) {
  const ctrl = useController();
  return ( <Menu><Tip label="More"><MenuTrigger asChild><IconButton label="Thread actions"><DotsThreeIcon size={16} /></IconButton></MenuTrigger></Tip>
      <MenuContent align="end">
        <MenuItem icon={<PencilSimpleIcon size={14} />} onSelect={onRename}>Rename</MenuItem>
        <MenuItem icon={<ArrowsInIcon size={14} />} onSelect={() => void ctrl.compact(sessionId)} disabled={isReadOnly}>Compact context</MenuItem>
        {cwd ? <MenuItem icon={<FolderOpenIcon size={14} />} onSelect={() => void ctrl.openFolder(cwd, "files")}>{revealLabel()}</MenuItem> : null}
        <MenuItem icon={<CopyIcon size={14} />} onSelect={() => void navigator.clipboard?.writeText(sessionId)}>Copy session ID</MenuItem>
        <MenuSeparator />
        <MenuItem icon={<ArchiveIcon size={14} />} onSelect={() => void ctrl.archive(sessionId)}>Archive thread</MenuItem></MenuContent></Menu>
  );
}

function ThreadHeader(props: {
  session: SessionSummary;
  thread: ThreadState | null;
  running: boolean;
  busy: boolean;
  crew: CrewVM | null;
  crewStale: boolean;
}) {
  const ctrl = useController();
  const { session, thread } = props;
  const [isRenamingTitle, setIsRenamingTitle] = useState(false);

  const fold = thread?.fold ?? null;
  const pendingRequestsCount = fold ? Object.keys(fold.approvals).length + Object.keys(fold.userInputs).length : 0;
  const startedAt = fold?.activeTurnId ? fold.turns[fold.activeTurnId]?.startedAt : undefined;

  const dragAreaProps = useOverlayDragProps();
  const noDragProps = useOverlayDragProps("off");
  const activeSide = useApp((st) => st.prefs.sidePanel);

  const activeRun = headerRun(props.crew);
  const isReportDismissed = useApp((s) => {
    return activeRun ? s.crew.dismissedReports.includes(`${session.sessionId}:${activeRun.itemId}`) : true;
  });

  const isLandedEvent = useLanded(activeRun);
  const isRunActive = activeRun !== null && runLive(activeRun);

  const isFilesTrayOpen = activeSide === "files";
  const isBrowserTrayOpen = activeSide === "browser";

  const renderCrewStatus = () => {
    if (pendingRequestsCount > 0) return <CrewStatus kind="waiting" />;
    if ((props.running || props.busy) && props.crewStale) return <CrewStatus kind="stale" />;
    if (props.running || props.busy) {
      return <CrewStatus kind="working" ms={startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : null} at={Date.now()} live />;
    }
    if (isLandedEvent && activeRun && activeRun.counts.unknown === 0) {
      return <CrewStatus kind={activeRun.kind === "turn" ? "done" : "landed"} ms={activeRun.elapsedMs} />;
    }
    if (activeRun && activeRun.stale && isRunActive) {
      return <CrewStatus kind="stale" ms={staleAge(activeRun, activeRun.clockAt)} />;
    }
    if (activeRun && !isRunActive && !isReportDismissed && activeRun.status === "finished" && activeRun.counts.unknown === 0) {
      return <CrewStatus kind="done" />;
    }
    if (thread?.readOnly) return <ThreadLockBadge />;
    return null;
  };

  const handleTitleDone = (title: string | null) => {
    setIsRenamingTitle(false);
    if (title !== null) {
      void ctrl.rename(session.sessionId, title);
    }
  };

  return ( <header data-drag-region {...dragAreaProps} className="@container flex h-12 shrink-0 items-center gap-1.5 overflow-hidden border-b border-line px-3">
      <TrafficLightSpacer />
      <SidebarToggle />
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        {isRenamingTitle ? (
          <TitleField initial={session.title} onDone={handleTitleDone} />
        ) : (
          <h1 data-no-drag {...noDragProps} title={`${session.title} (double-click to rename)`} onDoubleClick={() => setIsRenamingTitle(true)} className="min-w-0 flex-1 cursor-text truncate overflow-hidden text-sm font-semibold text-nowrap text-ellipsis text-fg">{session.title}</h1>
        )}
        {session.cwd ? (
          <span className="hidden min-w-0 shrink @min-[420px]:flex">
            <ProjectFolderBadge cwd={session.cwd} />
          </span>
        ) : null}
        {fold?.meta.branch ? <GitBranchHeaderChip branch={fold.meta.branch} /> : null}
      </div>

      {session.sandboxDisabled === true ? <SandboxDisabledAlert /> : null}

      <NeedsYouChip count={pendingRequestsCount} onClick={() => focusRequestPanel()} />
      {renderCrewStatus()}

      {props.running ? <StopTurnHeaderButton sessionId={session.sessionId} /> : null}

      <HiddenCardsButton sessionId={session.sessionId} running={props.running} />

      <CrewToggle
        active={activeSide === "crew"}
        count={props.crew ? (isRunActive && activeRun ? activeRun.counts.total : 0) + props.crew.tasks.length + props.crew.subagents.length || null : null}
        onClick={() => ctrl.toggleCrewPanel()} />

      <Tip label="Browser" shortcut={[MOD, "Shift", "B"]}>
        <IconButton
          label={isBrowserTrayOpen ? "Hide the browser" : "Show the browser"}
          active={isBrowserTrayOpen}
          onClick={() => ctrl.toggleBrowserPanel()}>
          <GlobeIcon size={15} /></IconButton></Tip>

      <Tip label={isFilesTrayOpen ? "Hide files" : "Show files"} shortcut={[MOD, "Shift", "E"]}>
        <IconButton
          label={isFilesTrayOpen ? "Hide files" : "Show files"}
          active={isFilesTrayOpen}
          onClick={() => ctrl.toggleFiles()}>
          <TreeStructureIcon size={15} /></IconButton></Tip>

      <OpenInEditorButton cwd={session.cwd} />

      <ThreadHeaderMenu
        sessionId={session.sessionId}
        cwd={session.cwd}
        onRename={() => setIsRenamingTitle(true)}
        isReadOnly={Boolean(thread?.readOnly)} />
      <CaptionSpacer />
    </header>
  );
}

function HiddenCardsButton(props: { sessionId: string; running: boolean }) {
  const ctrl = useController();
  const hiddenLabels = useApp((st) => {
    const hiddenList = st.prefs.hiddenCards;
    const threadFold = st.threads[props.sessionId]?.fold;
    if (!threadFold || !hiddenList.some((k) => k.endsWith(`:${props.sessionId}`))) return "";
    const labels: string[] = [];
    if (hiddenList.includes(`plan:${props.sessionId}`) && taskPlanItems(threadFold.meta.todoList).length > 0) {
      labels.push("plan");
    }
    if (hiddenList.includes(`goal:${props.sessionId}`) && goalView(threadFold) !== null) {
      labels.push("goal");
    }
    return labels.join(", ");
  });

  if (!hiddenLabels) return null;
  const buttonTip = `Show the ${hiddenLabels.replace(/, ([^,]*)$/, " and $1")}`;

  return ( <Tip label={buttonTip}>
      <IconButton label={buttonTip} onClick={() => ctrl.showThreadCards(props.sessionId)}>
        <SquareHalfBottomIcon size={15} /></IconButton></Tip>
  );
}

function ThreadStatusNotices({
  thread,
  sessionId,
  running,
}: {
  thread: ThreadState | null;
  sessionId: string;
  running: boolean;
}) {
  const ctrl = useController();
  if (thread?.readOnly) {
    return ( <ReadOnlyNotice
        reason={thread.readOnlyReason}
        busy={thread.load === "loading"}
        onRetry={() => void ctrl.loadThread(sessionId)} />
    );
  }
  if (thread && running && !thread.readOnly && (thread.stalled || thread.historySync)) {
    return ( <StalledNotice
        busy={thread.load === "loading"}
        historySync={thread.historySync}
        onRetry={() => void ctrl.retryStalledThread(sessionId)} />
    );
  }
  return null;
}

function DockComposerSection({
  sessionId,
  cwd,
  running,
  readOnly,
  branch,
  fold,
  approvalsCount,
  inputsCount,
}: {
  sessionId: string;
  cwd: string | null;
  running: boolean;
  readOnly: boolean;
  branch: string | null;
  fold: ThreadState["fold"] | null;
  approvalsCount: number;
  inputsCount: number;
}) {
  return ( <div className="flex flex-col gap-2">
      <TelemetryPills sessionId={sessionId} />
      <Composer sessionId={sessionId} cwd={cwd} running={running} readOnly={readOnly} variant="thread" autoFocus />
      <ComposerFooter cwd={cwd} branch={branch} running={running} lead={<ThreadPresence fold={fold} running={running} waiting={approvalsCount + inputsCount} />} />
    </div>
  );
}

function Dock(props: {
  session: SessionSummary;
  thread: ThreadState | null;
  running: boolean;
  crew: CrewVM | null;
  crewStale: boolean;
}) {
  const { session, thread } = props;
  const fold = thread?.fold ?? null;

  const approvalList = fold ? Object.values(fold.approvals) : [];
  const userInputList = fold ? Object.values(fold.userInputs) : [];
  const queuedEchoes = fold ? fold.echoes.filter((e) => e.disposition === "queued") : [];

  const derivedPlan = fold ? taskPlanView(fold, { stale: props.crewStale, crew: props.crew }) : null;
  const isPlanSuppressed = useApp((st) => st.prefs.hiddenCards.includes(`plan:${session.sessionId}`));
  const dismissedReportsList = useApp((st) => st.crew.dismissedReports);

  const mainRun = props.crew
    ? primaryRun(props.crew, session.sessionId, props.crew.runs[0]?.clockAt ?? Date.now(), dismissedReportsList)
    : null;

  const resolvedPlanPlacement = isPlanSuppressed ? "none" : planPlace(mainRun, derivedPlan);

  return ( <div className="shrink-0">
      <div className="mx-auto flex w-full max-w-[776px] flex-col gap-2 px-4 pb-2 @min-[520px]:px-6">
        <ThreadStatusNotices thread={thread} sessionId={session.sessionId} running={props.running} />

        {props.crew ? (
          <CrewDockCard
            sessionId={session.sessionId}
            view={props.crew}
            stale={props.crewStale}
            readOnly={Boolean(thread?.readOnly)}
            compact={approvalList.length + userInputList.length > 0}
            plan={isPlanSuppressed ? null : derivedPlan} />
        ) : null}

        {approvalList.map((req, idx) => (
          <ApprovalPanel key={req.approvalId} request={req} primary={idx === 0} />
        ))}

        {userInputList.map((req, idx) => (
          <QuestionPanel key={req.userInputId} request={req} keyboard={approvalList.length === 0 && idx === 0} />
        ))}

        <GoalPanel sessionId={session.sessionId} running={props.running} readOnly={Boolean(thread?.readOnly)} />

        <AnimatePresence initial={false} key={session.sessionId}>
          {derivedPlan && resolvedPlanPlacement === "own" ? (
            <motion.div
              key="plan"
              exit={{ height: 0, opacity: 0, marginTop: -8, overflow: "hidden" }}
              transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}>
              <PlanPanel sessionId={session.sessionId} view={derivedPlan} />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {queuedEchoes.length > 0 ? <QueuedList sessionId={session.sessionId} items={queuedEchoes} /> : null}

        <DockComposerSection
          sessionId={session.sessionId} cwd={session.cwd}
          running={props.running} readOnly={Boolean(thread?.readOnly)}
          branch={fold?.meta.branch ?? null} fold={fold}
          approvalsCount={approvalList.length} inputsCount={userInputList.length} />
      </div>
    </div>
  );
}

function MissingThread() {
  const ctrl = useController();
  const dragProps = useOverlayDragProps();
  return ( <div className="flex h-full flex-1 flex-col">
      <header data-drag-region {...dragProps} className="flex h-12 items-center px-3"><TrafficLightSpacer /><SidebarToggle /><CaptionSpacer /></header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 pb-[12vh] text-center">
        <p className="font-display text-2xl text-fg">This thread is not here anymore</p>
        <p className="max-w-[40ch] text-sm text-muted">It may have been archived or removed with its project.</p>
        <button type="button" className="mt-2 text-sm font-medium text-brand-text hover:underline" onClick={() => ctrl.newThread()}>Start a new thread</button>
      </div></div>
  );
}