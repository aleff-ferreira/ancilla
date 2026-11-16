import {
  ArchiveIcon, ArrowClockwiseIcon, ArrowLineDownIcon, ArrowUUpLeftIcon, ArrowsClockwiseIcon,
  BrainIcon, CaretRightIcon, ChartBarIcon, CheckIcon, CodeIcon, CopyIcon, DotsThreeIcon,
  DownloadSimpleIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon, FunnelSimpleIcon,
  GearSixIcon, GitBranchIcon, MagnifyingGlassIcon, MonitorIcon, MoonIcon, NotePencilIcon,
  PauseIcon, PencilSimpleIcon, PlayIcon, PushPinIcon, PushPinSlashIcon, ShieldSlashIcon,
  SidebarSimpleIcon, StackIcon, SunIcon, TargetIcon, XIcon,
} from "../ui/icons.js";
import { memo, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { shallowEqual, useApp, useController, useNow } from "../../app/context.js";
import { useOverlayDragProps, useTitlebarOverlay } from "../../app/frame.js";
import { basename, formatElapsed, relativeTime } from "../../model/format.js";
import { statusLabel } from "../../model/goal.js";
import { PlanPill } from "../usage/PlanMeter.js";
import {
  STATUS_LABEL, groupByProject, groupByStatus, isLive, settledEntries, threadStatus,
  type ProjectGroup, type SidebarEntry,
} from "../../model/status.js";
import { CODE_THEMES, DEFAULT_SIDEBAR_WIDTH, type CodeTheme } from "../../model/store.js";
import { providerBadgeName } from "../../model/models.js";
import type { UpdateState } from "../../model/updates.js";
import type { ProjectView, ProviderId, SessionSummary } from "../../types.js";
import {
  Menu, MenuCheck, MenuContent, MenuItem, MenuOption, MenuRadioGroup,
  MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger, Tip,
} from "../ui/overlays.js";
import { IconButton, Logo, MOD, Shortcut, Spinner, cn, isMac } from "../ui/primitives.js";
import { StatusGlyph } from "../ui/StatusGlyph.js";
import type { SidebarCrewSummary } from "../../model/crew.js";
import { ActivityButton } from "../crew/ActivityBadge.js";
import { SidebarCrewRow, useSidebarCrew } from "../crew/SidebarCrewRow.js";
import { CompanionChip } from "../assistant/companion/CompanionChip.js";

const DropdownMenu = Menu;
const MenuFlyout = MenuContent;
const MenuOpenTrigger = MenuTrigger;
const MenuDivider = MenuSeparator;
const MenuSection = MenuSub;
const MenuSectionTrigger = MenuSubTrigger;
const MenuSectionContent = MenuSubContent;

const DRAG_CONFIG = {
  projectPreviewCount: 6,
  statusPreviewCount: 30,
  endDropTarget: "end",
  reorderSlopThreshold: 6,
  shelfInitialPageSize: 10,
  shelfPageIncrement: 25,
} as const;

export const REORDER_SLOP = DRAG_CONFIG.reorderSlopThreshold;

const COPY_CONSTS = {
  autoUpdateDesc: "Download new versions in the background and install them when Ancilla closes",
  emptyHeading: "No projects yet",
  emptyDesc: "Add a folder to start a thread. Threads you ran from the Muse terminal show up here on their own.",
  searchingThreads: "Looking for Muse threads",
  macReveal: "Reveal in Finder",
  winReveal: "Open in File Explorer",
  otherReveal: "Open folder",
} as const;

export const CODE_THEME_LABELS: Record<CodeTheme, string> = {
  ancilla: "Ancilla", ayu: "Ayu", github: "GitHub",
  vercel: "Vercel", cursor: "Cursor", catppuccin: "Catppuccin",
};

export type ProjectDragActions = { onDragStart: (cwd: string) => void; onDragOver: (cwd: string) => void; onDrop: (cwd: string, beforeCwd: string | null) => void; onDragEnd: () => void; };

export type ProjectSectionProps = ProjectDragActions & { group: ProjectGroup; collapsed: boolean; activeId: string | null; now: number; dragging: string | null; over: string | null; };

function TipIconButton({
  tip,
  label,
  icon,
  onClick,
  disabled,
  size = "xs",
  className,
  shortcut,
  side,
  align,
}: {
  tip: string;
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  size?: "xs" | "sm" | "md";
  className?: string;
  shortcut?: string[];
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) {
  return (
    <Tip label={tip} shortcut={shortcut} side={side} align={align}>
      <IconButton size={size} label={label} onClick={onClick} disabled={disabled} className={className}>
        {icon}
      </IconButton>
    </Tip>
  );
}

function ShelfExpandButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-7 w-full items-center rounded-lg pl-[30px] text-left text-xs text-subtle hover:bg-hover hover:text-fg">
      {label}
    </button>
  );
}

function GitBranchLabel({ branch }: { branch: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <GitBranchIcon size={11} className="shrink-0" aria-hidden="true" /> <span className="truncate font-mono text-2xs">{branch}</span>
    </span>
  );
}

function projectUnderPoint(screenX: number, screenY: number): string | null {
  const elements = document.elementsFromPoint(screenX, screenY);
  for (let idx = 0; idx < elements.length; idx++) {
    const el = elements[idx];
    if (!(el instanceof Element)) continue;
    if (el.closest("[data-project-end-drop]")) return DRAG_CONFIG.endDropTarget;
    const projectSectionEl = el.closest<HTMLElement>("[data-project-cwd]");
    const targetDir = projectSectionEl?.dataset?.projectCwd;
    if (targetDir) return targetDir;
  }
  return null;
}

export function revealLabel(): string {
  if (isMac) return COPY_CONSTS.macReveal;
  const isWindowsEnv = typeof navigator !== "undefined" && /Win/.test(navigator.platform);
  return isWindowsEnv ? COPY_CONSTS.winReveal : COPY_CONSTS.otherReveal;
}

export function updateSummary(updates: UpdateState, autoUpdate: boolean, paused: boolean, now: number): string {
  const st = updates.status;
  const targetVer = updates.update?.version ? String(updates.update.version) : "";
  if (st === "checking") return "Checking for updates";
  if (st === "installing") return "Installing the update";
  if (st === "error") return "Could not check for updates";
  if (st === "available") {
    return paused ? `Version ${targetVer} is available. Updates are paused.` : `Version ${targetVer} is available`;
  }
  if (st === "downloading") {
    const pct = updates.progress != null ? `, ${Math.round(updates.progress * 100)}%` : "";
    return `Downloading version ${targetVer}${pct}`;
  }
  if (st === "ready") {
    const backgroundInstall = autoUpdate && !paused;
    return backgroundInstall ? `Version ${targetVer} installs when you close Ancilla` : `Version ${targetVer} is ready to install`;
  }
  if (st === "upToDate") {
    if (paused) return "Up to date. Updates are paused.";
    const elapsed = updates.checkedAt ? relativeTime(new Date(updates.checkedAt).toISOString(), now) : "";
    return elapsed && elapsed !== "now" ? `Up to date, checked ${elapsed} ago` : "Up to date";
  }
  if (paused) return "Updates are paused";
  return autoUpdate ? "Ancilla updates itself" : "Automatic updates are off";
}

function useSidebarEntries(): { entries: SidebarEntry[]; activeId: string | null } {
  const sessionMap = useApp((s) => s.sessions);
  const threadMap = useApp((s) => s.threads);
  const seenMap = useApp((s) => s.prefs.lastSeen);
  const timeBaseline = useApp((s) => s.prefs.baseline);
  const currentActiveId = useApp((s) => (s.route.kind === "thread" ? s.route.sessionId : null));

  const entries = useMemo(() => {
    return Object.values(sessionMap).map((sessionSummary) => ({
      session: sessionSummary,
      status: threadStatus(sessionSummary, {
        fold: threadMap[sessionSummary.sessionId]?.fold ?? null,
        lastSeen: seenMap[sessionSummary.sessionId] ?? null,
        baseline: timeBaseline,
        active: sessionSummary.sessionId === currentActiveId,
      }),
    }));
  }, [sessionMap, threadMap, seenMap, timeBaseline, currentActiveId]);

  return { entries, activeId: currentActiveId };
}

function WindowDragSpacer() {
  const overlayDrag = useOverlayDragProps("self");
  return <div data-drag-region {...overlayDrag} aria-hidden="true" className="h-10 shrink-0" />;
}

function SidebarNavItem({
  iconElement,
  itemLabel,
  shortcutKeys,
  isSelected = false,
  onActivate,
}: {
  iconElement: ReactNode;
  itemLabel: string;
  shortcutKeys: string[];
  isSelected?: boolean;
  onActivate: () => void;
}) {
  const rowTone = isSelected ? "text-fg" : "text-muted hover:bg-hover hover:text-fg";
  return (
    <button type="button" onClick={onActivate} aria-current={isSelected ? "page" : undefined} className={cn("selection-row group/nav relative flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-sm transition-colors duration-100", rowTone)}>
      <span className="flex size-4 shrink-0 items-center justify-center">{iconElement}</span>
      <span className="min-w-0 flex-1 truncate text-left">{itemLabel}</span>
      <span className="hidden shrink-0 @min-[16rem]:block">
        <Shortcut keys={shortcutKeys} className="opacity-0 transition-opacity duration-150 group-hover/nav:opacity-100" />
      </span>
    </button>
  );
}

function SidebarHeader({
  currentRoute,
  onCollapseSidebar,
  onStartThread,
  onSearchThreads,
}: {
  currentRoute: string;
  onCollapseSidebar: () => void;
  onStartThread: () => void;
  onSearchThreads: () => void;
}) {
  const topDrag = useOverlayDragProps();
  return (
    <div data-drag-region {...topDrag} className="flex flex-col gap-px px-2 pt-2 pb-1.5">
      <div className="mb-2 flex h-8 items-center gap-2 pr-0.5 pl-1.5">
        <Logo size={22} />
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-fg">Ancilla</span>
        <span className="flex-1" />
        <TipIconButton tip="Hide sidebar" label="Hide sidebar" icon={<SidebarSimpleIcon size={16} />} shortcut={[MOD, "B"]} onClick={onCollapseSidebar} />
      </div>
      <SidebarNavItem
        iconElement={<NotePencilIcon size={15} />}
        itemLabel="New thread"
        shortcutKeys={[MOD, "Shift", "O"]}
        isSelected={currentRoute === "new"}
        onActivate={onStartThread}
      />
      <SidebarNavItem
        iconElement={<MagnifyingGlassIcon size={15} />}
        itemLabel="Search"
        shortcutKeys={[MOD, "K"]}
        onActivate={onSearchThreads}
      />
      <div className="mt-2"><CompanionChip /></div>
    </div>
  );
}

function ElapsedTimeIndicator({ session }: { session: SessionSummary }) {
  const foldTimestamp = useApp((s) => {
    const fld = s.threads[session.sessionId]?.fold;
    return fld?.activeTurnId ? (fld.turns[fld.activeTurnId]?.startedAt ?? null) : null;
  });
  const liveTimestamp = session.live?.turnStartedAt ? Date.parse(session.live.turnStartedAt) : null;
  const initialTick = foldTimestamp ?? liveTimestamp;
  const secondTicker = useNow(1000);

  return (
    <span className="text-accent-text">
      Working
      {initialTick ? <span className="ml-1">{formatElapsed(secondTicker - initialTick)}</span> : null}
    </span>
  );
}

function SessionStatusIndicator({ entry, now, settled = false }: { entry: SidebarEntry; now: number; settled?: boolean }) {
  const { session, status } = entry;
  if (settled) return <span className="text-subtle">{relativeTime(session.settledAt ?? session.activityAt, now)}</span>;
  if (status === "running") return <ElapsedTimeIndicator session={session} />;
  if (status === "approval") return <span className="font-medium text-warn-text">Approval</span>;
  if (status === "input") return <span className="font-medium text-status-input">Input</span>;
  if (status === "failed") return <span className="font-medium text-danger-text">Failed</span>;
  if (status === "unread") {
    return <span className="flex items-center gap-1 font-medium text-ok-text"><CheckIcon size={11} aria-hidden="true" /> Done</span>;
  }
  return <span className="text-subtle">{relativeTime(session.activityAt, now)}</span>;
}

function SessionMetaDetails({
  session,
  displayProject = false,
  crewSummary,
}: {
  session: SessionSummary;
  displayProject?: boolean;
  crewSummary?: SidebarCrewSummary | null;
}) {
  const gitBranch = useApp((s) => s.threads[session.sessionId]?.fold.meta.branch ?? null);
  const activeObjective = useApp((s) => {
    const currentFold = s.threads[session.sessionId]?.fold;
    return currentFold?.meta.goalSeen ? currentFold.meta.goal : (session.live?.goal ?? null);
  });
  const objectiveTone = activeObjective ? statusLabel(activeObjective.status).tone : null;
  const isGoalActive = activeObjective !== null && (objectiveTone === "active" || objectiveTone === "paused" || objectiveTone === "attention");

  if (!displayProject && !gitBranch && !isGoalActive && !crewSummary) {
    return null;
  }

  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-subtle">
      {displayProject ? <span className="truncate">{basename(session.cwd)}</span> : null}
      {isGoalActive && activeObjective ? (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 tabular-nums",
            objectiveTone === "active" ? "text-accent-text" : objectiveTone === "attention" ? "text-warn-text" : "text-subtle",
          )}
          title={`Goal: ${activeObjective.objective}`}
        >
          <TargetIcon size={11} className="shrink-0" aria-hidden="true" />
          <span className="sr-only">Goal </span>
          {Math.round(Math.max(0, Math.min(100, activeObjective.percentComplete)))}%
        </span>
      ) : null}
      {crewSummary ? <SidebarCrewRow summary={crewSummary} /> : gitBranch ? <GitBranchLabel branch={gitBranch} /> : null}
    </span>
  );
}

function ProviderSessionBadge({ accountId, providerId }: { accountId: string | null; providerId?: ProviderId }) {
  const badgeConfig = useApp((s) => {
    if (!providerId || providerId === "muse") {
      if (!accountId) return null;
      const matched = s.accounts?.find((a) => a.id === accountId) ?? null;
      return matched ? { hoverText: `Account: ${matched.name}`, displayText: matched.name } : null;
    }
    const acctRecord = accountId ? ((s.providerAccounts ?? []).find((a) => a.id === accountId) ?? null) : null;
    const shortLabel = providerBadgeName(providerId);
    const resolvedText = providerId === "api" ? (acctRecord ? `API · ${acctRecord.name}` : "API") : acctRecord ? `${shortLabel} · ${acctRecord.name}` : shortLabel;
    return { hoverText: `Provider: ${resolvedText}`, displayText: resolvedText };
  }, shallowEqual);

  if (!badgeConfig) return null;

  return (
    <span
      title={badgeConfig.hoverText}
      className="max-w-[7rem] shrink-0 truncate rounded bg-active px-1 py-px text-2xs font-medium text-muted"
    >
      {badgeConfig.displayText}
    </span>
  );
}

function ThreadRenameInput({ defaultValue, onCommit }: { defaultValue: string; onCommit: (text: string | null) => void }) {
  const isFinished = useRef(false);
  const commitChange = (val: string | null) => {
    if (!isFinished.current) {
      isFinished.current = true;
      onCommit(val);
    }
  };

  return (
    <input
      autoFocus
      defaultValue={defaultValue}
      aria-label="Thread title"
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => commitChange(e.currentTarget.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") commitChange(e.currentTarget.value);
        else if (e.key === "Escape") commitChange(null);
      }}
      className="relative z-10 h-6 min-w-0 flex-1 rounded-md bg-raised px-1.5 text-sm text-fg outline-none shadow-[0_0_0_1.5px_var(--focus-ring)]"
    />
  );
}

function ThreadActionMenu({ session, onTriggerRename }: { session: SessionSummary; onTriggerRename: () => void }) {
  const ctrl = useController();
  const threadOptions = [
    { label: "Rename", icon: <PencilSimpleIcon size={14} />, act: onTriggerRename },
    { label: "Copy session ID", icon: <CopyIcon size={14} />, act: () => void navigator.clipboard?.writeText(session.sessionId) },
    { label: revealLabel(), icon: <FolderOpenIcon size={14} />, act: () => void ctrl.openFolder(session.cwd, "files") },
  ];
  return (
    <DropdownMenu>
      <MenuOpenTrigger asChild>
        <IconButton size="xs" label="Thread actions"><DotsThreeIcon size={14} /></IconButton>
      </MenuOpenTrigger>
      <MenuFlyout align="end">
        {threadOptions.map((item) => (
          <MenuItem key={item.label} icon={item.icon} onSelect={item.act}>{item.label}</MenuItem>
        ))}
        <MenuDivider />
        <MenuItem icon={<ArchiveIcon size={14} />} onSelect={() => void ctrl.archive(session.sessionId)}>Archive thread</MenuItem>
      </MenuFlyout>
    </DropdownMenu>
  );
}

function SandboxDisabledBadge() {
  return (
    <span title="Sandbox off" className="flex shrink-0 text-warn-text">
      <ShieldSlashIcon size={12} aria-hidden="true" />
    </span>
  );
}

function ThreadTitleButton({
  session,
  status,
  active,
  settled,
  showProject,
  crewSummary,
  onOpen,
  onTriggerRename,
}: {
  session: SessionSummary;
  status: SidebarEntry["status"];
  active: boolean;
  settled?: boolean;
  showProject?: boolean;
  crewSummary?: SidebarCrewSummary | null;
  onOpen: () => void;
  onTriggerRename: () => void;
}) {
  const hasFocusTone = active || status === "unread" || isLive(status);
  const titleAriaText = `, ${STATUS_LABEL[status]}${session.sandboxDisabled === true ? ", sandbox off" : ""}${session.accountId ? ", using a separate account" : ""}`;
  const textToneClass = settled ? "text-subtle" : hasFocusTone ? "text-fg" : "text-muted";

  return (
    <button type="button" onClick={onOpen} onDoubleClick={onTriggerRename} aria-current={active ? "page" : undefined} title={session.title} className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-focus focus-visible:after:outline">
      <span className={cn("flex min-w-0 items-center gap-1.5 text-sm", textToneClass, status === "unread" && !settled && "font-medium")}>
        {session.sandboxDisabled === true ? <SandboxDisabledBadge /> : null}
        <ProviderSessionBadge accountId={session.accountId} providerId={session.providerId} />
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
      </span>
      {!settled ? <SessionMetaDetails session={session} displayProject={showProject} crewSummary={crewSummary} /> : null}
      <span className="sr-only">{titleAriaText}</span>
    </button>
  );
}

export const ThreadRow = memo(
  function ThreadRow({
    entry,
    active,
    now,
    showProject,
    settled = false,
  }: {
    entry: SidebarEntry;
    active: boolean;
    now: number;
    showProject?: boolean;
    settled?: boolean;
  }) {
    const ctrl = useController();
    const { session, status } = entry;
    const [editingTitle, setEditingTitle] = useState(false);
    const activeCrew = useSidebarCrew(session, status, now);

    return (
      <li>
        <div
          data-selected={active || undefined}
          className={cn(
            "selection-row group/row relative flex min-h-8 items-center gap-2 rounded-md py-1 pr-1 pl-[30px] transition-colors duration-100",
            !active && "hover:bg-hover",
          )}
        >
          {!settled ? (
            <span className="absolute top-1/2 left-[10px] flex size-4 -translate-y-1/2 items-center justify-center">
              <StatusGlyph status={status} />
            </span>
          ) : null}
          {editingTitle ? (
            <ThreadRenameInput
              defaultValue={session.title}
              onCommit={(updatedName) => {
                setEditingTitle(false);
                if (updatedName !== null) void ctrl.rename(session.sessionId, updatedName);
              }}
            />
          ) : (
            <ThreadTitleButton
              session={session}
              status={status}
              active={active}
              settled={settled}
              showProject={showProject}
              crewSummary={activeCrew}
              onOpen={() => ctrl.openThread(session.sessionId)}
              onTriggerRename={() => setEditingTitle(true)}
            />
          )}
          {!editingTitle ? (
            <>
              <span className="shrink-0 pr-1.5 text-2xs tabular-nums group-focus-within/row:hidden group-hover/row:hidden group-has-[[data-state=open]]/row:hidden" aria-hidden="true">
                <SessionStatusIndicator entry={entry} now={now} settled={settled} />
              </span>
              <div className="relative z-10 hidden items-center group-focus-within/row:flex group-hover/row:flex group-has-[[data-state=open]]/row:flex">
                {settled ? (
                  <TipIconButton tip="Un-settle" label="Un-settle thread" icon={<ArrowUUpLeftIcon size={13} />} onClick={() => void ctrl.setSettled(session.sessionId, false)} />
                ) : !isLive(status) ? (
                  <TipIconButton tip="Settle" label="Settle thread" icon={<CheckIcon size={14} />} onClick={() => void ctrl.setSettled(session.sessionId, true)} />
                ) : null}
                <ThreadActionMenu session={session} onTriggerRename={() => setEditingTitle(true)} />
              </div>
            </>
          ) : null}
        </div>
      </li>
    );
  },
  (prevProps, nextProps) =>
    prevProps.entry.session === nextProps.entry.session &&
    prevProps.entry.status === nextProps.entry.status &&
    prevProps.active === nextProps.active &&
    prevProps.now === nextProps.now &&
    prevProps.showProject === nextProps.showProject &&
    prevProps.settled === nextProps.settled,
);

function ProjectActionMenu({ project }: { project: ProjectView }) {
  const ctrl = useController();
  const pinItem = {
    caption: project.pinned ? "Unpin" : "Pin to top",
    icon: project.pinned ? <PushPinSlashIcon size={14} /> : <PushPinIcon size={14} />,
    handleSelect: () => void ctrl.togglePin(project.cwd),
  };

  const projectActionGroups = [
    [
      { id: "new", icon: <NotePencilIcon size={14} />, text: "New thread", act: () => ctrl.newThread(project.cwd) },
      { id: "pin", icon: pinItem.icon, text: pinItem.caption, act: pinItem.handleSelect },
    ],
    [
      { id: "reveal", icon: <FolderOpenIcon size={14} />, text: revealLabel(), act: () => void ctrl.openFolder(project.cwd, "files") },
      { id: "code", icon: <CodeIcon size={14} />, text: "Open in VS Code", act: () => void ctrl.openFolder(project.cwd, "editor") },
      { id: "copy", icon: <CopyIcon size={14} />, text: "Copy path", act: () => void navigator.clipboard?.writeText(project.cwd) },
      { id: "refresh", icon: <ArrowsClockwiseIcon size={14} />, text: "Refresh threads", act: () => void ctrl.refreshProject(project.cwd) },
    ],
  ];

  return (
    <DropdownMenu>
      <MenuOpenTrigger asChild>
        <IconButton size="xs" label={`${project.displayName} actions`}><DotsThreeIcon size={14} /></IconButton>
      </MenuOpenTrigger>
      <MenuFlyout align="end">
        {projectActionGroups[0]!.map((it) => (
          <MenuItem key={it.id} icon={it.icon} onSelect={it.act}>{it.text}</MenuItem>
        ))}
        <MenuDivider />
        {projectActionGroups[1]!.map((it) => (
          <MenuItem key={it.id} icon={it.icon} onSelect={it.act}>{it.text}</MenuItem>
        ))}
        <MenuDivider />
        <MenuItem icon={<FolderPlusIcon size={14} />} onSelect={() => ctrl.setAddProjectOpen({ folderFor: project.cwd })}>Add folder…</MenuItem>
        {project.folders.length > 1 ? <ProjectSubfoldersMenu project={project} /> : null}
        <MenuDivider />
        <MenuItem icon={<XIcon size={14} />} tone="danger" onSelect={() => void ctrl.hideProject(project.cwd)}>Remove from sidebar</MenuItem>
      </MenuFlyout>
    </DropdownMenu>
  );
}

function ProjectSubfoldersMenu({ project }: { project: ProjectView }) {
  const ctrl = useController();
  return (
    <MenuSection>
      <MenuSectionTrigger icon={<FolderIcon size={14} />} hint={String(project.folders.length)}>Folders</MenuSectionTrigger>
      <MenuSectionContent>
        {project.folders.map((folder, folderIdx) => {
          const isPrimary = folderIdx === 0;
          return (
            <MenuSection key={folder.cwd}>
              <MenuSectionTrigger icon={isPrimary ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />} hint={isPrimary ? "main" : undefined}>
                {folder.displayName}
              </MenuSectionTrigger>
              <MenuSectionContent>
                <MenuItem icon={<FolderOpenIcon size={14} />} onSelect={() => void ctrl.openFolder(folder.cwd, "files")}>{revealLabel()}</MenuItem>
                <MenuItem icon={<CopyIcon size={14} />} onSelect={() => void navigator.clipboard?.writeText(folder.cwd)}>Copy path</MenuItem>
                {!isPrimary && (
                  <MenuDivider />
                )}
                {!isPrimary && (
                  <MenuItem icon={<XIcon size={14} />} tone="danger" onSelect={() => void ctrl.removeProjectFolder(project.cwd, folder.cwd)}>Remove from project</MenuItem>
                )}
              </MenuSectionContent>
            </MenuSection>
          );
        })}
      </MenuSectionContent>
    </MenuSection>
  );
}

const GROUP_OPTIONS = [
  { val: "project", icon: <FolderIcon size={14} />, label: "By project", desc: "Each project with its threads" },
  { val: "status", icon: <StackIcon size={14} />, label: "By status", desc: "Needs you, working, ready for review" },
] as const;

function GroupingOptionsDropdown() {
  const ctrl = useController();
  const currentGrouping = useApp((s) => s.prefs.groupBy);
  return (
    <DropdownMenu>
      <Tip label="Group threads">
        <MenuOpenTrigger asChild>
          <IconButton size="xs" label="Group threads">
            <FunnelSimpleIcon size={14} />
          </IconButton>
        </MenuOpenTrigger>
      </Tip>
      <MenuFlyout align="end">
        <MenuRadioGroup value={currentGrouping} onValueChange={(val) => ctrl.setGroupBy(val === "status" ? "status" : "project")}>
          {GROUP_OPTIONS.map((g) => (
            <MenuOption key={g.val} value={g.val} icon={g.icon} label={g.label} description={g.desc} />
          ))}
        </MenuRadioGroup>
      </MenuFlyout>
    </DropdownMenu>
  );
}

function SettledShelfFolder({
  shelfStorageKey,
  entries,
  activeId,
  now,
  showProject = false,
}: {
  shelfStorageKey: string;
  entries: SidebarEntry[];
  activeId: string | null;
  now: number;
  showProject?: boolean;
}) {
  const ctrl = useController();
  const isShelfOpen = useApp((s) => s.prefs.openShelves.includes(shelfStorageKey));
  const [shelfItemLimit, setShelfItemLimit] = useState<number>(DRAG_CONFIG.shelfInitialPageSize);
  const visibleEntries = isShelfOpen ? entries.slice(0, shelfItemLimit) : entries.filter((e) => e.session.sessionId === activeId);

  return (
    <div className="mt-1">
      <button type="button" aria-expanded={isShelfOpen} onClick={() => ctrl.toggleShelf(shelfStorageKey)} className="group/shelf flex h-7 w-full items-center gap-2 rounded-lg pr-2 pl-[30px] text-left text-xs text-subtle transition-colors duration-100 hover:text-fg">
        <span>Settled</span>
        <span className="tabular-nums">{entries.length}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
        <CaretRightIcon size={12} className={cn("shrink-0 transition-transform duration-150 ease-out", isShelfOpen && "rotate-90")} />
      </button>
      {visibleEntries.length > 0 ? (
        <ul className="flex flex-col gap-px">
          {visibleEntries.map((e) => (
            <ThreadRow
              key={e.session.sessionId}
              entry={e}
              active={e.session.sessionId === activeId}
              now={now}
              showProject={showProject}
              settled
            />
          ))}
        </ul>
      ) : null}
      {isShelfOpen && entries.length > shelfItemLimit ? (
        <ShelfExpandButton
          label={`Show ${Math.min(DRAG_CONFIG.shelfPageIncrement, entries.length - shelfItemLimit)} more`}
          onClick={() => setShelfItemLimit((curr) => curr + DRAG_CONFIG.shelfPageIncrement)}
        />
      ) : null}
    </div>
  );
}

function StatusGroupSection({
  headerTitle,
  entries,
  activeId,
  now,
  hasCap,
}: {
  headerTitle: string;
  entries: SidebarEntry[];
  activeId: string | null;
  now: number;
  hasCap: boolean;
}) {
  const [expandedSection, setExpandedSection] = useState(false);
  const boundaryCount = hasCap && !expandedSection ? DRAG_CONFIG.statusPreviewCount : entries.length;

  return (
    <section className="mb-2" aria-label={headerTitle}>
      <h3 className="flex h-7 items-center gap-2 px-2 text-xs font-medium text-subtle">
        <span>{headerTitle}</span>
        <span className="tabular-nums">{entries.length}</span>
      </h3>
      <ul className="flex flex-col gap-px">
        {entries.slice(0, boundaryCount).map((entry) => (
          <ThreadRow
            key={entry.session.sessionId}
            entry={entry}
            active={entry.session.sessionId === activeId}
            now={now}
            showProject
          />
        ))}
        {entries.length > boundaryCount && (
          <li><ShelfExpandButton label={`Show ${entries.length - boundaryCount} more`} onClick={() => setExpandedSection(true)} /></li>
        )}
      </ul>
    </section>
  );
}

function ProjectHeaderActions({ project, onNewThread }: { project: ProjectView; onNewThread: () => void }) {
  return (
    <div data-no-reorder className="flex shrink-0 items-center opacity-0 transition-opacity duration-100 group-hover/project:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
      <TipIconButton
        tip={`New thread in ${project.displayName}`}
        label={`New thread in ${project.displayName}`}
        icon={<NotePencilIcon size={13} />}
        onClick={onNewThread}
      />
      <ProjectActionMenu project={project} />
    </div>
  );
}

export const ProjectSection = memo(function ProjectSection(props: ProjectSectionProps) {
  const { group, collapsed, activeId, now, dragging, over, onDragStart, onDragOver, onDrop, onDragEnd } = props;
  const ctrl = useController();
  const noWindowDragProps = useOverlayDragProps("off");
  const dragTriggeredTracker = useRef(false);
  const [showAllThreads, setShowAllThreads] = useState(false);
  const { project, entries } = group;

  const activeThreadIndex = entries.findIndex((e) => e.session.sessionId === activeId);
  const runningSessionsTotal = entries.filter((e) => isLive(e.status)).length;
  const initialThreadLimit = showAllThreads
    ? entries.length
    : Math.max(DRAG_CONFIG.projectPreviewCount, runningSessionsTotal, activeThreadIndex + 1);
  const visibleEntriesList = entries.slice(0, initialThreadLimit);

  const isCurrentDragged = dragging === project.cwd;
  const isDropTargetActive = over === project.cwd && dragging && dragging !== project.cwd;
  const lineIndicatorTone = isDropTargetActive ? "bg-accent" : "bg-transparent";

  const onPointerPress = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const targetEl = e.target;
    if (targetEl instanceof Element && targetEl.closest("[data-no-reorder]")) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const projectCwd = project.cwd;
    let didBeginDrag = false;

    const handlePointerDrag = (ev: globalThis.PointerEvent) => {
      if (!didBeginDrag) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_CONFIG.reorderSlopThreshold) return;
        didBeginDrag = true;
        dragTriggeredTracker.current = true;
        onDragStart(projectCwd);
      }
      const targetHovered = projectUnderPoint(ev.clientX, ev.clientY);
      if (targetHovered) onDragOver(targetHovered);
    };

    const handlePointerRelease = (ev: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", handlePointerDrag);
      window.removeEventListener("pointerup", handlePointerRelease);
      window.removeEventListener("pointercancel", handlePointerRelease);

      setTimeout(() => {
        dragTriggeredTracker.current = false;
      }, 0);

      if (!didBeginDrag) return;

      const finishLocation = projectUnderPoint(ev.clientX, ev.clientY);
      if (finishLocation === DRAG_CONFIG.endDropTarget) {
        onDrop(projectCwd, null);
      } else if (finishLocation && finishLocation !== projectCwd) {
        onDrop(projectCwd, finishLocation);
      } else {
        onDragEnd();
      }
    };

    window.addEventListener("pointermove", handlePointerDrag);
    window.addEventListener("pointerup", handlePointerRelease);
    window.addEventListener("pointercancel", handlePointerRelease);
  };

  const preventClickOnDrag = (ev: React.MouseEvent) => {
    if (!dragTriggeredTracker.current) return;
    dragTriggeredTracker.current = false;
    ev.preventDefault();
    ev.stopPropagation();
  };

  const projectFolderPathsString = project.folders.map((f) => f.cwd).join("\n");

  return (
    <section
      data-project-cwd={project.cwd}
      className={cn("mb-1", isCurrentDragged && "opacity-50")}
      aria-label={project.displayName}
    >
      <div className={cn("mx-1 mb-0.5 h-0.5 rounded-full transition-colors duration-100", lineIndicatorTone)} />
      <div
        data-no-drag
        {...noWindowDragProps}
        onPointerDown={onPointerPress}
        onClickCapture={preventClickOnDrag}
        className="group/project flex h-8 cursor-grab items-center gap-0.5 rounded-md pr-1 transition-colors duration-100 hover:bg-hover active:cursor-grabbing"
      >
        <button type="button" aria-expanded={!collapsed} onClick={() => ctrl.toggleProjectCollapsed(project.cwd)} className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5 text-left" title={projectFolderPathsString}>
          <CaretRightIcon size={13} className={cn("shrink-0 text-subtle transition-transform duration-150 ease-out", !collapsed && "rotate-90")} />
          {collapsed ? <FolderIcon size={15} className="shrink-0 text-subtle" /> : <FolderOpenIcon size={15} className="shrink-0 text-subtle" />}
          <span className="truncate text-sm font-medium text-fg">{project.displayName}</span>
          {project.pinned ? <PushPinIcon size={11} className="shrink-0 text-subtle" aria-label="Pinned" /> : null}
          {collapsed && group.attention > 0 ? (
            <span className="mr-1 ml-auto size-1.5 shrink-0 rounded-full bg-warn" aria-label={`${group.attention} need you`} />
          ) : collapsed && group.running > 0 ? (
            <Spinner size={10} className="mr-1 ml-auto text-accent-text" label="Working" />
          ) : null}
        </button>
        <ProjectHeaderActions project={project} onNewThread={() => ctrl.newThread(project.cwd)} />
      </div>
      {!collapsed ? (
        <ul className="flex flex-col gap-px pt-px">
          {visibleEntriesList.map((entry) => (
            <ThreadRow
              key={entry.session.sessionId}
              entry={entry}
              active={entry.session.sessionId === activeId}
              now={now}
              showProject={project.folders.length > 1 && entry.session.cwd !== project.cwd}
            />
          ))}
          {entries.length === 0 && group.settled.length === 0 && (
            <li><ShelfExpandButton label="Start the first thread" onClick={() => ctrl.newThread(project.cwd)} /></li>
          )}
          {(entries.length > visibleEntriesList.length || (showAllThreads && entries.length > DRAG_CONFIG.projectPreviewCount)) && (
            <li><ShelfExpandButton label={showAllThreads ? "Show fewer" : `Show ${entries.length - visibleEntriesList.length} more`} onClick={() => setShowAllThreads((prev) => !prev)} /></li>
          )}
        </ul>
      ) : null}
      {!collapsed && group.settled.length > 0 ? (
        <SettledShelfFolder shelfStorageKey={`project:${project.cwd}`} entries={group.settled} activeId={activeId} now={now} />
      ) : null}
    </section>
  );
});

function ProjectNavigationSection({
  groups,
  collapsedCwds,
  activeId,
  now,
  draggedCwd,
  overCwd,
  onStartDrag,
  onOverDrag,
  onPerformDrop,
  onCancelDrag,
  bottomDropClass,
}: {
  groups: ProjectGroup[];
  collapsedCwds: string[];
  activeId: string | null;
  now: number;
  draggedCwd: string | null;
  overCwd: string | null;
  onStartDrag: (cwd: string) => void;
  onOverDrag: (cwd: string) => void;
  onPerformDrop: (cwd: string, beforeCwd: string | null) => void;
  onCancelDrag: () => void;
  bottomDropClass: string;
}) {
  return (
    <>
      {groups.map((grp) => (
        <ProjectSection
          key={grp.project.cwd}
          group={grp}
          collapsed={collapsedCwds.includes(grp.project.cwd)}
          activeId={activeId}
          now={now}
          dragging={draggedCwd}
          over={overCwd}
          onDragStart={onStartDrag}
          onDragOver={onOverDrag}
          onDrop={onPerformDrop}
          onDragEnd={onCancelDrag}
        />
      ))}
      {draggedCwd ? (
        <div
          aria-hidden="true"
          data-project-end-drop=""
          className={cn("mx-1 h-7 rounded-lg border border-dashed transition-colors duration-100", bottomDropClass)}
        />
      ) : null}
    </>
  );
}

function StatusNavigationSection({
  categories,
  settledEntries,
  activeId,
  now,
}: {
  categories: { id: string; label: string; entries: SidebarEntry[] }[];
  settledEntries: SidebarEntry[];
  activeId: string | null;
  now: number;
}) {
  return (
    <>
      {categories.map((cat) => (
        <StatusGroupSection key={cat.id} headerTitle={cat.label} entries={cat.entries} activeId={activeId} now={now} hasCap={cat.id === "idle"} />
      ))}
      {settledEntries.length > 0 ? (
        <SettledShelfFolder shelfStorageKey="status" entries={settledEntries} activeId={activeId} now={now} showProject />
      ) : null}
    </>
  );
}

function ThreadNavigationTree() {
  const ctrl = useController();
  const projectList = useApp((s) => s.projects);
  const layoutGroupMode = useApp((s) => s.prefs.groupBy);
  const collapsedProjectCwds = useApp((s) => s.prefs.collapsedProjects);
  const areSessionsReady = useApp((s) => s.sessionsLoaded);
  const refreshTimestamp = useNow(30_000);
  const { entries, activeId } = useSidebarEntries();

  const projectHierarchy = useMemo(() => groupByProject(projectList, entries), [projectList, entries]);
  const [draggedProjectCwd, setDraggedProjectCwd] = useState<string | null>(null);
  const [dragOverTargetCwd, setDragOverTargetCwd] = useState<string | null>(null);

  const clearDragCoordinates = () => {
    setDraggedProjectCwd(null);
    setDragOverTargetCwd(null);
  };

  const executeDropAction = (cwd: string, beforeCwd: string | null) => {
    void ctrl.reorderProjects(cwd, beforeCwd);
    clearDragCoordinates();
  };

  const statusCategories = useMemo(() => groupByStatus(entries), [entries]);
  const settledSessionEntries = useMemo(() => settledEntries(entries), [entries]);

  const treeHeaderLabel = layoutGroupMode === "project" ? "Projects" : "By status";
  const isEndHoverActive = dragOverTargetCwd === DRAG_CONFIG.endDropTarget;
  const bottomDropZoneClass = isEndHoverActive ? "border-accent bg-hover" : "border-line";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 items-center justify-between pr-2 pl-3.5">
        <h2 className="text-xs font-medium text-subtle">{treeHeaderLabel}</h2>
        <div className="flex items-center gap-0.5">
          <GroupingOptionsDropdown />
          <TipIconButton tip="Add project" label="Add project" icon={<FolderPlusIcon size={14} />} onClick={() => ctrl.setAddProjectOpen(true)} />
        </div>
      </div>
      <nav aria-label="Threads" className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-6">
        {!areSessionsReady ? (
          <SidebarPlaceholderSkeleton />
        ) : projectList.length === 0 ? (
          <SidebarEmptyWorkspacePrompt />
        ) : layoutGroupMode === "project" ? (
          <ProjectNavigationSection
            groups={projectHierarchy}
            collapsedCwds={collapsedProjectCwds}
            activeId={activeId}
            now={refreshTimestamp}
            draggedCwd={draggedProjectCwd}
            overCwd={dragOverTargetCwd}
            onStartDrag={setDraggedProjectCwd}
            onOverDrag={setDragOverTargetCwd}
            onPerformDrop={executeDropAction}
            onCancelDrag={clearDragCoordinates}
            bottomDropClass={bottomDropZoneClass}
          />
        ) : (
          <StatusNavigationSection
            categories={statusCategories}
            settledEntries={settledSessionEntries}
            activeId={activeId}
            now={refreshTimestamp}
          />
        )}
      </nav>
    </div>
  );
}

function UpdateSummaryHeader({
  updates,
  autoUpdate,
  paused,
  now,
}: {
  updates: UpdateState;
  autoUpdate: boolean;
  paused: boolean;
  now: number;
}) {
  const currentVer = updates.currentVersion ?? "";
  const isDownloading = updates.status === "downloading" && updates.progress !== null;
  return (
    <div className="px-2 pt-1.5 pb-2">
      <p className="text-sm font-medium text-fg">{`Ancilla ${currentVer}`}</p>
      <p className="mt-0.5 text-xs text-muted">{updateSummary(updates, autoUpdate, paused, now)}</p>
      {isDownloading ? (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-active" role="progressbar" aria-valuenow={Math.round(updates.progress! * 100)}>
          <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${updates.progress! * 100}%` }} />
        </div>
      ) : null}
      {updates.error ? <p className="mt-1.5 text-xs break-words text-danger-text">{updates.error}</p> : null}
    </div>
  );
}

function ApplicationUpdatesMenu() {
  const ctrl = useController();
  const updatesState = useApp((s) => s.updates);
  const autoUpdateEnabled = useApp((s) => s.prefs.autoUpdate);
  const areUpdatesPaused = useApp((s) => s.prefs.updatesPaused);
  const minuteClock = useNow(60_000);

  if (!updatesState) return null;

  const currentStatus = updatesState.status;
  const targetVer = updatesState.update?.version ?? "";
  const hasUpdatePending = currentStatus === "available" || currentStatus === "downloading" || currentStatus === "ready";
  const isBusyUpdating = currentStatus === "checking" || currentStatus === "downloading" || currentStatus === "installing";

  const tipText = currentStatus === "ready"
    ? `Ancilla ${targetVer} is ready to install`
    : hasUpdatePending
      ? `Ancilla ${targetVer} is available`
      : "Updates";
  const indicatorDotClass = currentStatus === "ready" ? "bg-accent" : "bg-accent/50";

  return (
    <DropdownMenu>
      <Tip label={tipText} side="top">
        <MenuOpenTrigger asChild>
          <IconButton label="Updates" className="relative">
            <DownloadSimpleIcon size={15} />
            {hasUpdatePending ? <span aria-hidden="true" className={cn("absolute top-1.5 right-1.5 size-1.5 rounded-full", indicatorDotClass)} /> : null}
          </IconButton>
        </MenuOpenTrigger>
      </Tip>
      <MenuFlyout side="top" align="start" className="w-[290px]">
        <UpdateSummaryHeader updates={updatesState} autoUpdate={autoUpdateEnabled} paused={areUpdatesPaused} now={minuteClock} />
        <MenuDivider />
        {currentStatus === "ready" ? (
          <MenuItem icon={<ArrowClockwiseIcon size={14} />} onSelect={() => ctrl.restartToUpdate()}>Restart to update</MenuItem>
        ) : null}
        {currentStatus === "available" ? (
          <MenuItem icon={<ArrowLineDownIcon size={14} />} onSelect={() => ctrl.downloadUpdate()}>{`Download version ${targetVer}`}</MenuItem>
        ) : null}
        <MenuItem icon={<ArrowsClockwiseIcon size={14} />} disabled={isBusyUpdating} onSelect={() => ctrl.checkForUpdates()}>Check for updates</MenuItem>
        <MenuDivider />
        <MenuCheck
          checked={autoUpdateEnabled}
          onChange={(flag) => ctrl.setAutoUpdate(flag)}
          description={COPY_CONSTS.autoUpdateDesc}
        >
          Automatic updates
        </MenuCheck>
        <MenuItem icon={areUpdatesPaused ? <PlayIcon size={14} /> : <PauseIcon size={14} />} onSelect={() => ctrl.setUpdatesPaused(!areUpdatesPaused)}>
          {areUpdatesPaused ? "Resume updates" : "Pause updates"}
        </MenuItem>
      </MenuFlyout>
    </DropdownMenu>
  );
}

const THEME_OPTIONS_LIST = [
  { themeId: "system", title: "System", iconNode: <MonitorIcon size={14} /> },
  { themeId: "light", title: "Light", iconNode: <SunIcon size={14} /> },
  { themeId: "dark", title: "Dark", iconNode: <MoonIcon size={14} /> },
] as const;

function CodeThemeRadioGroup({
  activeCodeTheme,
  onChangeCodeTheme,
}: {
  activeCodeTheme: CodeTheme;
  onChangeCodeTheme: (val: CodeTheme) => void;
}) {
  return (
    <>
      <MenuDivider />
      <p className="px-2.5 pt-1 pb-1.5 text-2xs font-medium text-subtle">Code</p>
      <MenuRadioGroup
        value={activeCodeTheme}
        onValueChange={(val) => onChangeCodeTheme(CODE_THEMES.includes(val as CodeTheme) ? (val as CodeTheme) : "ancilla")}
      >
        {CODE_THEMES.map((themeName) => (
          <MenuOption
            key={themeName}
            value={themeName}
            icon={<span aria-hidden="true" className={cn("size-2.5 rounded-[3px]", `code-swatch-${themeName}`)} />}
            label={CODE_THEME_LABELS[themeName]}
          />
        ))}
      </MenuRadioGroup>
    </>
  );
}

function AppAppearanceMenu() {
  const ctrl = useController();
  const selectedTheme = useApp((s) => s.prefs.theme);
  const selectedCodeTheme = useApp((s) => s.prefs.codeTheme);

  const themeDisplayIcon = selectedTheme === "light"
    ? <SunIcon size={15} />
    : selectedTheme === "dark"
      ? <MoonIcon size={15} />
      : <MonitorIcon size={15} />;

  return (
    <DropdownMenu>
      <Tip label="Theme" side="top">
        <MenuOpenTrigger asChild>
          <IconButton size="xs" label="Theme">
            {themeDisplayIcon}
          </IconButton>
        </MenuOpenTrigger>
      </Tip>
      <MenuFlyout side="top" align="end" className="min-w-[160px]">
        <MenuRadioGroup value={selectedTheme} onValueChange={(t) => ctrl.setTheme(t === "light" || t === "dark" ? t : "system")}>
          {THEME_OPTIONS_LIST.map((opt) => (
            <MenuOption key={opt.themeId} value={opt.themeId} icon={opt.iconNode} label={opt.title} />
          ))}
        </MenuRadioGroup>
        <CodeThemeRadioGroup activeCodeTheme={selectedCodeTheme} onChangeCodeTheme={(t) => ctrl.setCodeTheme(t)} />
      </MenuFlyout>
    </DropdownMenu>
  );
}

function SidebarBottomBar() {
  const ctrl = useController();
  const hideAssistantChip = useApp((s) => s.prefs.assistantInvite === "hidden");
  const hostEnv = useApp((s) => s.env);
  const serverConnection = useApp((s) => s.connection);
  const scanningForThreads = useApp((s) => s.discovering);
  const daemonIssue = useApp((s) => s.hostError);

  const hasAltProviderAvailable = useApp((s) => {
    const customAccts = s.providerAccounts ?? [];
    if (customAccts.some((a) => a.providerId === "api" || a.providerId === "acp-custom" || a.providerId.startsWith("acp:"))) {
      return true;
    }
    const registeredProviders = s.providers ?? [];
    return registeredProviders.some(
      (p) => p.id !== "muse" && p.id !== "api" && (p.defaultAuth.state === "authenticated" || p.defaultAuth.state === "ready" || p.binary.available),
    );
  });

  const connectionBanner = serverConnection === "lost"
    ? { dotClass: "bg-warn", message: "Reconnecting to Ancilla" }
    : daemonIssue
      ? hasAltProviderAvailable
        ? { dotClass: "bg-ok", message: "Providers ready" }
        : { dotClass: "bg-danger", message: "Muse needs attention" }
      : hostEnv?.platform === "win32" && hostEnv.runtime !== "native"
        ? { dotClass: "bg-ok", message: `Muse in WSL (${hostEnv.defaultDistro ?? "Ubuntu"})` }
        : { dotClass: "bg-ok", message: "Muse ready" };

  const footerHoverText = daemonIssue ?? (hostEnv?.musePath ? `${hostEnv.musePath}  |  Ancilla ${hostEnv.version}` : `Ancilla ${hostEnv?.version ?? ""}`);

  const bottomNavButtons = [
    hideAssistantChip ? { id: "asst", tip: "Assistant: memory and tasks", label: "Assistant", icon: <BrainIcon size={14} />, dest: { kind: "assistant" as const } } : null,
    { id: "usage", tip: "Usage and cost", label: "Usage and cost", icon: <ChartBarIcon size={14} />, dest: { kind: "usage" as const } },
    { id: "settings", tip: "Settings", label: "Settings", icon: <GearSixIcon size={14} />, dest: { kind: "settings" as const } },
  ].filter(Boolean);

  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 border-t border-line px-2">
      <Tip label={footerHoverText} side="top" align="start">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-xs text-muted" tabIndex={0}>
          <span className={cn("size-1.5 shrink-0 rounded-full", connectionBanner.dotClass)} aria-hidden="true" />
          <span className="truncate">{connectionBanner.message}</span>
        </div>
      </Tip>
      <ActivityButton />
      <TipIconButton
        tip="Refresh threads from Muse"
        label="Refresh threads from Muse"
        icon={<ArrowsClockwiseIcon size={14} className={cn(scanningForThreads && "animate-spin")} />}
        onClick={() => void ctrl.discoverAll()}
        disabled={scanningForThreads}
        side="top"
      />
      <PlanPill />
      {bottomNavButtons.map((btn) => btn && (
        <TipIconButton
          key={btn.id}
          tip={btn.tip}
          label={btn.label}
          icon={btn.icon}
          onClick={() => ctrl.navigate(btn.dest)}
          side="top"
        />
      ))}
      <ApplicationUpdatesMenu />
      <AppAppearanceMenu />
    </div>
  );
}

function SidebarResizeGrip() {
  const ctrl = useController();

  const onStartResize = (ev: PointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const targetElement = ev.currentTarget;
    const initialCoordX = ev.clientX;
    const baseWidth = ctrl.store.get().prefs.sidebarWidth;
    targetElement.setPointerCapture(ev.pointerId);
    document.body.style.cursor = "col-resize";

    const onPointerDragMove = (e: globalThis.PointerEvent) => {
      ctrl.setSidebarWidth(baseWidth + e.clientX - initialCoordX);
    };

    const onPointerDragEnd = () => {
      targetElement.removeEventListener("pointermove", onPointerDragMove);
      targetElement.removeEventListener("pointerup", onPointerDragEnd);
      targetElement.removeEventListener("pointercancel", onPointerDragEnd);
      document.body.style.cursor = "";
    };

    targetElement.addEventListener("pointermove", onPointerDragMove);
    targetElement.addEventListener("pointerup", onPointerDragEnd);
    targetElement.addEventListener("pointercancel", onPointerDragEnd);
  };

  const onKeyAdjustWidth = (e: KeyboardEvent<HTMLDivElement>) => {
    const existingWidth = ctrl.store.get().prefs.sidebarWidth;
    if (e.key === "ArrowLeft") ctrl.setSidebarWidth(existingWidth - 16);
    else if (e.key === "ArrowRight") ctrl.setSidebarWidth(existingWidth + 16);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onPointerDown={onStartResize}
      onDoubleClick={() => ctrl.setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={onKeyAdjustWidth}
      className="absolute top-0 right-[-3px] z-[var(--z-resize)] h-full w-1.5 cursor-col-resize transition-colors duration-150 hover:bg-brand/35 focus-visible:bg-focus focus-visible:outline-none"
    />
  );
}

const SKELETON_BAR_WIDTHS = [62, 80, 54, 70, 46, 66] as const;

function SidebarPlaceholderSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-2 pt-2" aria-hidden="true">
      {SKELETON_BAR_WIDTHS.map((widthPercent, barIndex) => {
        const leftIndent = barIndex % 3 === 0 ? 0 : 22;
        return (
          <div
            key={barIndex}
            className="h-3 rounded bg-hover"
            style={{ width: `${widthPercent}%`, marginLeft: leftIndent }}
          />
        );
      })}
    </div>
  );
}

function SidebarEmptyWorkspacePrompt() {
  const ctrl = useController();
  const threadSearchActive = useApp((s) => s.discovering);
  return (
    <div className="px-2 pt-3 text-sm">
      <p className="font-medium text-fg">{COPY_CONSTS.emptyHeading}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">{COPY_CONSTS.emptyDesc}</p>
      <button type="button" onClick={() => ctrl.setAddProjectOpen(true)} className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-brand-text hover:bg-hover">
        <FolderPlusIcon size={14} /> Add project
      </button>
      {threadSearchActive ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-subtle">
          <Spinner size={10} /> {COPY_CONSTS.searchingThreads}
        </p>
      ) : null}
    </div>
  );
}

export function Sidebar() {
  const panelWidth = useApp((s) => s.prefs.sidebarWidth);
  const showTitlebar = useTitlebarOverlay();
  const ctrl = useController();
  const activeRoute = useApp((s) => s.route.kind);

  return (
    <aside
      aria-label="Sidebar" className="@container relative flex h-full shrink-0 flex-col border-r border-line bg-sidebar"
      style={{ width: panelWidth }}
    >
      {showTitlebar ? <WindowDragSpacer /> : null}
      <SidebarHeader
        currentRoute={activeRoute}
        onCollapseSidebar={() => ctrl.toggleSidebar()}
        onStartThread={() => ctrl.newThread()}
        onSearchThreads={() => ctrl.setPaletteOpen(true)}
      />
      <ThreadNavigationTree />
      <SidebarBottomBar />
      <SidebarResizeGrip />
    </aside>
  );
}

export { useSidebarEntries, shallowEqual };
