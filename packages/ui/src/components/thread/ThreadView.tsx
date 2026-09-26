import { ArchiveIcon, ArrowsInIcon, CodeIcon, CopyIcon, DotsThreeIcon, FolderIcon, FolderOpenIcon, GitBranchIcon, LockIcon, NotePencilIcon, PencilSimpleIcon, ShieldSlashIcon, SquareHalfBottomIcon, SquareIcon, TreeStructureIcon } from "../ui/icons.js";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import { CaptionSpacer, useOverlayDragProps } from "../../app/frame.js";
import { basename } from "../../model/format.js";
import { goalView } from "../../model/goal.js";
import { agentFeedRecovered, agentNumbers, markAgentFeed, type AgentFeedMark } from "../../model/agents.js";
import { runLive, swarmBusy, swarmView, type SwarmVM } from "../../model/swarm.js";
import type { ThreadState } from "../../model/store.js";
import type { SessionSummary } from "../../types.js";
import { SidebarToggle, TrafficLightSpacer } from "../chrome.js";
import { Composer, ComposerFooter } from "../composer/Composer.js";
import { TelemetryPills } from "../composer/TelemetryPills.js";
import { ApprovalPanel, PlanPanel, QuestionPanel, QueuedList, ReadOnlyNotice, StalledNotice } from "../requests/Requests.js";
import { GoalPanel } from "./GoalPanel.js";
import { revealLabel } from "../sidebar/Sidebar.js";
import { NeedsYouChip, SwarmStatus, SwarmToggle, focusRequestPanel, headerRun, staleAge, useLanded } from "../swarm/HeaderChips.js";
import { SwarmDockCard } from "../swarm/SwarmCard.js";
import { SwarmPanel } from "../swarm/SwarmPanel.js";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tip } from "../ui/overlays.js";
import { IconButton, MOD } from "../ui/primitives.js";
import { FilesPanel } from "../files/FilesPanel.js";
import { Transcript } from "./Transcript.js";

/** Ages in the Swarm card tick this often; the elapsed clocks tick on their own 1 s timer (SPEC §13). */
const AGE_TICK_MS = 15_000;

export function ThreadView(props: { sessionId: string }) {
  const session = useApp((s) => s.sessions[props.sessionId] ?? null);
  const thread = useApp((s) => s.threads[props.sessionId] ?? null);
  const sidePanel = useApp((s) => s.prefs.sidePanel);
  const connection = useApp((s) => s.connection);
  const models = useApp((s) => s.models);
  const pending = useApp((s) => s.swarm.pending);
  const skipped = useApp((s) => s.swarm.skipped);
  const fold = thread?.fold ?? null;
  const agentItems = fold ? fold.agentItems ?? fold.items : null;
  // Remember the agent items as the last history read left them while the live view is unavailable, to tell
  // agent progress arriving live after it apart from what a read brings back.
  const viewUnavailable = session?.live?.viewHealth?.status === "unavailable";
  const [feedMark, setFeedMark] = useState<AgentFeedMark | null>(null);
  const nextFeedMark = markAgentFeed(feedMark, props.sessionId, viewUnavailable, thread?.load ?? "idle", agentItems);
  if (nextFeedMark !== feedMark) {
    setFeedMark(nextFeedMark);
  }
  const busy = fold ? swarmBusy(fold) : false;
  const now = useNow(AGE_TICK_MS, busy);
  const swarmStale = connection !== "open" || Boolean(thread?.fold.closed || thread?.stalled || thread?.historySync || thread?.readOnly || thread?.stale)
    || (viewUnavailable && !agentFeedRecovered(nextFeedMark, props.sessionId, agentItems, thread?.fold.activeTurnId === null));
  // Until the first read lands the fold is a blank placeholder, which says nothing about the thread's agents.
  const loaded = !thread || thread.fold.order.length > 0 || thread.load === "ready";
  const swarm = useMemo<SwarmVM | null>(
    () => (fold && loaded ? swarmView(fold, session, now, { stale: swarmStale, partialHistory: thread?.truncated, pending, skipped, models, numbers: agentNumbers(props.sessionId) }) : null),
    // The view reads the agent items, the item order, the requests and the trace; streamed reply text changes none of them.
    [agentItems, fold?.order, fold?.approvals, fold?.userInputs, fold?.swarm, session, now, swarmStale, thread?.truncated, pending, skipped, models, loaded, props.sessionId],
  );
  if (!session) {
    return <MissingThread />;
  }
  const running = thread ? thread.fold.activeTurnId !== null : Boolean(session.live?.activeTurnId);
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <ThreadHeader session={session} thread={thread} running={running} swarm={swarm} />
      <div className="flex min-h-0 flex-1">
        <div className="@container flex min-w-0 flex-1 flex-col">
          {thread ? <Transcript sessionId={props.sessionId} thread={thread} /> : <div className="min-h-0 flex-1" />}
          <Dock session={session} thread={thread} running={running} swarm={swarm} swarmStale={swarmStale} />
        </div>
        {sidePanel === "swarm" ? <SwarmPanel sessionId={props.sessionId} />
          : sidePanel === "files" ? <FilesPanel sessionId={props.sessionId} cwd={session.cwd} /> : null}
      </div>
    </div>
  );
}

function ThreadHeader(props: { session: SessionSummary; thread: ThreadState | null; running: boolean; swarm: SwarmVM | null }) {
  const controller = useController();
  const { session, thread } = props;
  const [renaming, setRenaming] = useState(false);
  const fold = thread?.fold ?? null;
  const needs = fold ? Object.keys(fold.approvals).length + Object.keys(fold.userInputs).length : 0;
  const startedAt = fold?.activeTurnId ? fold.turns[fold.activeTurnId]?.startedAt : undefined;
  const drag = useOverlayDragProps();
  const noDrag = useOverlayDragProps("off");
  const sidePanel = useApp((s) => s.prefs.sidePanel);
  const reportDismissed = useApp((s) => {
    const run = headerRun(props.swarm);
    return run ? s.swarm.dismissedReports.includes(`${session.sessionId}:${run.itemId}`) : true;
  });
  const run = headerRun(props.swarm);
  const landed = useLanded(run);
  const liveRun = run !== null && runLive(run);
  const filesOpen = sidePanel === "files";
  return (
    <header data-drag-region {...drag} className="@container flex h-12 shrink-0 items-center gap-1.5 overflow-hidden border-b border-line px-3">
      <TrafficLightSpacer />
      <SidebarToggle />
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        {renaming ? (
          <TitleField
            initial={session.title}
            onDone={(title) => {
              setRenaming(false);
              if (title !== null) {
                void controller.rename(session.sessionId, title);
              }
            }}
          />
        ) : (
          <h1
            data-no-drag
            {...noDrag}
            className="min-w-0 flex-1 cursor-text truncate overflow-hidden text-sm font-semibold text-nowrap text-ellipsis text-fg"
            title={`${session.title} (double-click to rename)`}
            onDoubleClick={() => setRenaming(true)}
          >
            {session.title}
          </h1>
        )}
        <span className="hidden min-w-0 shrink @min-[420px]:flex">
          <ProjectChip cwd={session.cwd} />
        </span>
        {fold?.meta.branch ? (
          <span className="hidden min-w-0 items-center gap-1 text-xs text-subtle lg:flex">
            <GitBranchIcon size={12} className="shrink-0" />
            <span className="truncate font-mono text-2xs">{fold.meta.branch}</span>
          </span>
        ) : null}
      </div>
      {session.sandboxDisabled === true ? (
        <Tip label="This thread started while sandboxing was switched off, so its shells run unconfined">
          <span className="flex shrink-0 items-center gap-1.5 px-1 text-xs font-medium text-warn-text">
            <ShieldSlashIcon size={12} aria-hidden="true" />
            <span className="sr-only">Sandbox off</span>
            <span aria-hidden="true" className="@max-[420px]:hidden">Sandbox off</span>
          </span>
        </Tip>
      ) : null}
      <NeedsYouChip count={needs} onClick={() => focusRequestPanel()} />
      {needs > 0 ? (
        <SwarmStatus kind="waiting" />
      ) : props.running ? (
        <SwarmStatus kind="working" ms={startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : null} at={Date.now()} live />
      ) : landed && run ? (
        <SwarmStatus kind="landed" ms={run.elapsedMs} />
      ) : run && run.stale && liveRun ? (
        <SwarmStatus kind="stale" ms={staleAge(run, run.clockAt)} />
      ) : run && !liveRun && !reportDismissed && run.status === "finished" ? (
        <SwarmStatus kind="done" />
      ) : thread?.readOnly ? (
        <span className="flex shrink-0 items-center gap-1.5 px-1 text-xs text-subtle">
          <LockIcon size={12} />
          <span className="@max-[420px]:hidden">Read-only</span>
        </span>
      ) : null}
      {props.running ? (
        <Tip label="Stop the turn" shortcut={["Esc"]}>
          <IconButton label="Stop the turn" onClick={() => void controller.stop(session.sessionId)}>
            <SquareIcon weight="fill" size={11} />
          </IconButton>
        </Tip>
      ) : null}
      <HiddenCardsButton sessionId={session.sessionId} running={props.running} />
      <SwarmToggle active={sidePanel === "swarm"} count={liveRun ? run.counts.total : null} onClick={() => controller.toggleSwarmPanel()} />
      <Tip label={filesOpen ? "Hide files" : "Show files"} shortcut={[MOD, "Shift", "E"]}>
        <IconButton label={filesOpen ? "Hide files" : "Show files"} active={filesOpen} onClick={() => controller.toggleFiles()}>
          <TreeStructureIcon size={15} />
        </IconButton>
      </Tip>
      <span className="@max-[360px]:hidden">
        <Tip label="Open in VS Code">
          <IconButton label="Open in VS Code" onClick={() => void controller.openFolder(session.cwd, "editor")}>
            <CodeIcon size={15} />
          </IconButton>
        </Tip>
      </span>
      <Menu>
        <Tip label="More">
          <MenuTrigger asChild>
            <IconButton label="Thread actions">
              <DotsThreeIcon size={16} />
            </IconButton>
          </MenuTrigger>
        </Tip>
        <MenuContent align="end">
          <MenuItem icon={<PencilSimpleIcon size={14} />} onSelect={() => setRenaming(true)}>
            Rename
          </MenuItem>
          <MenuItem icon={<ArrowsInIcon size={14} />} onSelect={() => void controller.compact(session.sessionId)} disabled={thread?.readOnly}>
            Compact context
          </MenuItem>
          <MenuItem icon={<FolderOpenIcon size={14} />} onSelect={() => void controller.openFolder(session.cwd, "files")}>
            {revealLabel()}
          </MenuItem>
          <MenuItem icon={<CopyIcon size={14} />} onSelect={() => void navigator.clipboard?.writeText(session.sessionId)}>
            Copy session ID
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<ArchiveIcon size={14} />} onSelect={() => void controller.archive(session.sessionId)}>
            Archive thread
          </MenuItem>
        </MenuContent>
      </Menu>
      <CaptionSpacer />
    </header>
  );
}

function ProjectChip(props: { cwd: string }) {
  const controller = useController();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-subtle transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover"
          title={props.cwd}
        >
          <FolderIcon size={12} className="shrink-0" />
          <span className="truncate">{basename(props.cwd)}</span>
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem icon={<NotePencilIcon size={14} />} onSelect={() => controller.newThread(props.cwd)}>
          New thread in {basename(props.cwd)}
        </MenuItem>
        <MenuItem icon={<FolderOpenIcon size={14} />} onSelect={() => void controller.openFolder(props.cwd, "files")}>
          {revealLabel()}
        </MenuItem>
        <MenuItem icon={<CodeIcon size={14} />} onSelect={() => void controller.openFolder(props.cwd, "editor")}>
          Open in VS Code
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function TitleField(props: { initial: string; onDone: (title: string | null) => void }) {
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (!done.current) {
      done.current = true;
      props.onDone(value);
    }
  };
  return (
    <input
      autoFocus
      aria-label="Thread title"
      defaultValue={props.initial}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
          finish(e.currentTarget.value);
        } else if (e.key === "Escape") {
          finish(null);
        }
      }}
      className="h-7 w-[min(420px,50%)] rounded-md bg-raised px-2 text-sm font-semibold text-fg outline-none shadow-[0_0_0_1.5px_var(--accent)]"
    />
  );
}

function planShown(todo: ThreadState["fold"]["meta"]["todoList"] | null | undefined, running: boolean): boolean {
  return Boolean(todo && todo.length > 0 && (running || todo.some((t) => t.status !== "completed")));
}

/** Shown while a dock card the user closed has something to show; brings every closed card in the thread back. */
function HiddenCardsButton(props: { sessionId: string; running: boolean }) {
  const controller = useController();
  const names = useApp((s) => {
    const hidden = s.prefs.hiddenCards;
    const fold = s.threads[props.sessionId]?.fold;
    if (!fold || !hidden.some((k) => k.endsWith(`:${props.sessionId}`))) {
      return "";
    }
    const out: string[] = [];
    if (hidden.includes(`plan:${props.sessionId}`) && planShown(fold.meta.todoList, props.running)) {
      out.push("plan");
    }
    if (hidden.includes(`goal:${props.sessionId}`) && goalView(fold) !== null) {
      out.push("goal");
    }
    return out.join(", ");
  });
  if (!names) {
    return null;
  }
  const label = `Show the ${names.replace(/, ([^,]*)$/, " and $1")}`;
  return (
    <Tip label={label}>
      <IconButton label={label} onClick={() => controller.showThreadCards(props.sessionId)}>
        <SquareHalfBottomIcon size={15} />
      </IconButton>
    </Tip>
  );
}

function Dock(props: { session: SessionSummary; thread: ThreadState | null; running: boolean; swarm: SwarmVM | null; swarmStale: boolean }) {
  const controller = useController();
  const { session, thread } = props;
  const fold = thread?.fold ?? null;
  const approvals = fold ? Object.values(fold.approvals) : [];
  const inputs = fold ? Object.values(fold.userInputs) : [];
  const queued = fold ? fold.echoes.filter((e) => e.disposition === "queued") : [];
  const todo = fold?.meta.todoList ?? null;
  const showPlan = planShown(todo, props.running);
  return (
    <div className="shrink-0">
      <div className="mx-auto flex w-full max-w-[776px] flex-col gap-2 px-4 pb-2 @min-[520px]:px-6">
        {thread?.readOnly ? (
          <ReadOnlyNotice
            reason={thread.readOnlyReason}
            busy={thread.load === "loading"}
            onRetry={() => void controller.loadThread(session.sessionId)}
          />
        ) : null}
        {thread && props.running && !thread.readOnly && (thread.stalled || thread.historySync) ? (
          <StalledNotice
            busy={thread.load === "loading"}
            historySync={thread.historySync}
            onRetry={() => void controller.retryStalledThread(session.sessionId)}
          />
        ) : null}
        {props.swarm ? (
          <SwarmDockCard
            sessionId={session.sessionId}
            view={props.swarm}
            stale={props.swarmStale}
            readOnly={Boolean(thread?.readOnly)}
            compact={approvals.length + inputs.length > 0}
          />
        ) : null}
        {approvals.map((request, index) => (
          <ApprovalPanel key={request.approvalId} request={request} primary={index === 0} />
        ))}
        {inputs.map((request, index) => (
          <QuestionPanel key={request.userInputId} request={request} keyboard={approvals.length === 0 && index === 0} />
        ))}
        <GoalPanel sessionId={session.sessionId} running={props.running} readOnly={Boolean(thread?.readOnly)} />
        {showPlan && todo ? <PlanPanel sessionId={session.sessionId} items={todo} /> : null}
        {queued.length > 0 ? <QueuedList sessionId={session.sessionId} items={queued} /> : null}
        <TelemetryPills sessionId={session.sessionId} />
        <Composer
          sessionId={session.sessionId}
          cwd={session.cwd}
          running={props.running}
          readOnly={Boolean(thread?.readOnly)}
          variant="thread"
          autoFocus
        />
        <ComposerFooter cwd={session.cwd} branch={fold?.meta.branch ?? null} running={props.running} />
      </div>
    </div>
  );
}

function MissingThread() {
  const controller = useController();
  const drag = useOverlayDragProps();
  return (
    <div className="flex h-full flex-1 flex-col">
      <header data-drag-region {...drag} className="flex h-12 items-center px-3">
        <TrafficLightSpacer />
        <SidebarToggle />
        <CaptionSpacer />
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 pb-[12vh] text-center">
        <p className="font-display text-2xl text-fg">This thread is not here anymore</p>
        <p className="max-w-[40ch] text-sm text-muted">It may have been archived or removed with its project.</p>
        <button type="button" className="mt-2 text-sm font-medium text-accent-text hover:underline" onClick={() => controller.newThread()}>
          Start a new thread
        </button>
      </div>
    </div>
  );
}
