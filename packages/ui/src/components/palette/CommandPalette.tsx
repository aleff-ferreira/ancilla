import { Command } from "cmdk";
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowsClockwiseIcon,
  FolderIcon,
  FolderPlusIcon,
  GitForkIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  MonitorIcon,
  MoonIcon,
  NotePencilIcon,
  PulseIcon,
  ShieldSlashIcon,
  SidebarSimpleIcon,
  StackIcon,
  SunIcon,
} from "../ui/icons.js";
import { useCallback, useMemo, type ReactNode } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import { basename, relativeTime } from "../../model/format.js";
import { threadStatus } from "../../model/status.js";
import { Modal } from "../ui/overlays.js";
import { MOD, Shortcut } from "../ui/primitives.js";
import { StatusGlyph } from "../ui/StatusGlyph.js";
import type { ProjectView, SessionSummary } from "../../types.js";

const PALETTE_GROUP_CLASS =
  "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle";

const PALETTE_ROW_CLASS =
  "selection-row flex h-9 cursor-default items-center gap-3 rounded-lg px-2.5 text-sm text-fg outline-none select-none data-[selected=true]:bg-hover";

interface PaletteRowProps {
  value: string;
  keywords?: string[];
  onSelect: () => void;
  icon: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
}

function PaletteRow({ value, keywords, onSelect, icon, children, hint }: PaletteRowProps) {
  return (
    <Command.Item value={value} keywords={keywords} onSelect={onSelect} className={PALETTE_ROW_CLASS}>
      <span className="flex size-4 shrink-0 items-center justify-center text-muted">{icon}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {hint ? <span className="shrink-0 text-xs text-subtle">{hint}</span> : null}
    </Command.Item>
  );
}

function PaletteSearchBar() {
  return (
    <header className="flex h-12 items-center gap-2.5 border-b border-line px-4">
      <span className="shrink-0 text-subtle">
        <MagnifyingGlassIcon size={16} aria-hidden="true" />
      </span>
      <Command.Input
        placeholder="Search threads, projects and actions"
        className="h-full min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-subtle"
      />
    </header>
  );
}

interface ActionCommand {
  id: string;
  title: string;
  icon: ReactNode;
  execute: () => void;
  shortcutKeys?: string[];
  searchTerms?: string[];
  displayed?: boolean;
}

function ThreadPaletteRow({
  session,
  threadFold,
  lastSeenTimestamp,
  baselineCommit,
  nowTime,
  onActivate,
}: {
  session: SessionSummary;
  threadFold: any;
  lastSeenTimestamp?: string | null;
  baselineCommit: string;
  nowTime: number;
  onActivate: () => void;
}) {
  const currentStatus = threadStatus(session, {
    fold: threadFold,
    lastSeen: lastSeenTimestamp,
    baseline: baselineCommit,
    active: false,
  });
  const directoryName = basename(session.cwd);
  const isSecuritySandboxOff = Boolean(session.sandboxDisabled);

  return (
    <PaletteRow
      key={session.sessionId}
      value={`${session.title} ${session.sessionId}`}
      keywords={[directoryName]}
      icon={
        currentStatus === "idle" ? (
          <span className="size-[7px] rounded-full bg-line-strong" />
        ) : (
          <StatusGlyph status={currentStatus} />
        )
      }
      onSelect={onActivate}
      hint={relativeTime(session.activityAt, nowTime)}
    >
      <span className="truncate font-normal">{session.title}</span>
      {isSecuritySandboxOff && (
        <span title="Sandbox off" className="inline-flex shrink-0 items-center gap-1 text-warn-text">
          <ShieldSlashIcon size={12} aria-hidden="true" />
          <span className="sr-only"> (sandbox off)</span>
        </span>
      )}
      <span className="shrink-0 truncate text-xs text-subtle">{directoryName}</span>
    </PaletteRow>
  );
}

function ProjectPaletteRow({ project, onActivate }: { project: ProjectView; onActivate: () => void }) {
  return (
    <PaletteRow
      key={project.cwd}
      icon={<FolderIcon size={15} />}
      value={`New thread in ${project.displayName} ${project.cwd}`}
      onSelect={onActivate}
    >
      <span className="truncate font-normal">New thread in {project.displayName}</span>
      <span className="truncate text-xs text-subtle">{project.cwd}</span>
    </PaletteRow>
  );
}

export function CommandPalette() {
  const controller = useController();
  const isOpen = useApp((state) => state.paletteOpen);
  const sessionRecords = useApp((state) => state.sessions) as Record<string, SessionSummary>;
  const projectList = useApp((state) => state.projects);
  const threadMap = useApp((state) => state.threads);
  const baselineCommit = useApp((state) => state.prefs.baseline);
  const lastSeenMap = useApp((state) => state.prefs.lastSeen);
  const sidebarGroupMode = useApp((state) => state.prefs.groupBy);
  const updateInfo = useApp((state) => state.updates);
  const currentTime = useNow(60_000, isOpen);

  const chronologicalSessions = useMemo(() => {
    return Object.values(sessionRecords ?? {}).sort((sessionA, sessionB) =>
      sessionA.activityAt < sessionB.activityAt ? 1 : -1,
    );
  }, [sessionRecords]);

  const handleSelect = useCallback((actionCallback: () => void) => {
    controller.setPaletteOpen(false);
    actionCallback();
  }, [controller]);

  const actionCatalog: ActionCommand[] = [
    {
      id: "action-new-thread",
      title: "New thread",
      icon: <NotePencilIcon size={15} />,
      execute: () => controller.newThread(),
      shortcutKeys: [MOD, "Shift", "O"],
    },
    {
      id: "action-add-project",
      title: "Add project",
      icon: <FolderPlusIcon size={15} />,
      execute: () => controller.setAddProjectOpen(true),
    },
    {
      id: "action-refresh-threads",
      title: "Refresh threads from Muse",
      icon: <ArrowsClockwiseIcon size={15} />,
      execute: () => void controller.discoverAll(),
    },
    {
      id: "action-group-sidebar",
      title: sidebarGroupMode === "project" ? "Group sidebar by status" : "Group sidebar by project",
      icon: <StackIcon size={15} />,
      execute: () => controller.setGroupBy(sidebarGroupMode === "project" ? "status" : "project"),
    },
    {
      id: "action-toggle-sidebar",
      title: "Toggle sidebar",
      icon: <SidebarSimpleIcon size={15} />,
      execute: () => controller.toggleSidebar(),
      shortcutKeys: [MOD, "B"],
    },
    {
      id: "action-activity",
      title: "Activity",
      icon: <PulseIcon size={15} />,
      execute: () => controller.setActivityOpen(true),
      shortcutKeys: [MOD, "Shift", "A"],
      searchTerms: ["agents", "tasks", "running", "needs you", "drawer"],
    },
    {
      id: "action-browser-panel",
      title: "Browser",
      icon: <GlobeIcon size={15} />,
      execute: () => controller.toggleBrowserPanel(),
      shortcutKeys: [MOD, "Shift", "B"],
      searchTerms: ["web", "internet", "page", "site", "internal browser"],
    },
    {
      id: "action-crew-panel",
      title: "Crew panel",
      icon: <GitForkIcon size={15} />,
      execute: () => controller.toggleCrewPanel(),
      shortcutKeys: [MOD, "Shift", "M"],
      searchTerms: ["agents", "workflow", "timeline", "roster"],
    },
    {
      id: "action-theme-system",
      title: "Use system theme",
      icon: <MonitorIcon size={15} />,
      execute: () => controller.setTheme("system"),
      searchTerms: ["appearance"],
    },
    {
      id: "action-theme-light",
      title: "Use light theme",
      icon: <SunIcon size={15} />,
      execute: () => controller.setTheme("light"),
      searchTerms: ["appearance"],
    },
    {
      id: "action-theme-dark",
      title: "Use dark theme",
      icon: <MoonIcon size={15} />,
      execute: () => controller.setTheme("dark"),
      searchTerms: ["appearance"],
    },
    {
      id: "action-zoom-in",
      title: "Zoom in",
      icon: <MagnifyingGlassPlusIcon size={15} />,
      execute: () => controller.zoomIn(),
      shortcutKeys: [MOD, "+"],
      searchTerms: ["appearance", "bigger", "font size"],
    },
    {
      id: "action-zoom-out",
      title: "Zoom out",
      icon: <MagnifyingGlassMinusIcon size={15} />,
      execute: () => controller.zoomOut(),
      shortcutKeys: [MOD, "-"],
      searchTerms: ["appearance", "smaller", "font size"],
    },
    {
      id: "action-reset-zoom",
      title: "Reset zoom",
      icon: <ArrowCounterClockwiseIcon size={15} />,
      execute: () => controller.resetZoom(),
      shortcutKeys: [MOD, "0"],
      searchTerms: ["appearance", "100%"],
    },
    {
      id: "action-restart-update",
      title: `Restart to install Ancilla ${updateInfo?.update?.version ?? ""}`,
      icon: <ArrowClockwiseIcon size={15} />,
      execute: () => controller.restartToUpdate(),
      searchTerms: ["update", "install", "version"],
      displayed: updateInfo?.status === "ready",
    },
    {
      id: "action-check-updates",
      title: "Check for updates",
      icon: <ArrowsClockwiseIcon size={15} />,
      execute: () => controller.checkForUpdates(),
      searchTerms: ["update", "version"],
      displayed: Boolean(updateInfo),
    },
  ];

  return (
    <Modal
      open={isOpen}
      onOpenChange={(nextOpenState) => controller.setPaletteOpen(nextOpenState)}
      bare
      title="Search threads, projects and actions"
      hideTitle
      className="command-palette top-[12%] w-[min(620px,calc(100%-16px))] overflow-hidden rounded-xl"
    >
      <Command loop className="command-palette-shell" label="Search threads, projects and actions">
        <PaletteSearchBar />
        <Command.List className="overflow-y-auto max-h-[min(440px,62vh)] p-1.5">
          <Command.Empty className="px-3 py-10 text-center text-sm text-muted">Nothing matches that search.</Command.Empty>
          <Command.Group heading="Actions" className={PALETTE_GROUP_CLASS}>
            {actionCatalog
              .filter((catalogItem) => catalogItem.displayed !== false)
              .map((actionEntry) => (
                <PaletteRow
                  key={actionEntry.id}
                  value={actionEntry.title}
                  keywords={actionEntry.searchTerms as string[] | undefined}
                  icon={actionEntry.icon}
                  onSelect={() => handleSelect(actionEntry.execute)}
                  hint={actionEntry.shortcutKeys ? <Shortcut keys={actionEntry.shortcutKeys as string[]} /> : null}
                >
                  {actionEntry.title}
                </PaletteRow>
              ))}
          </Command.Group>
          {chronologicalSessions.length > 0 && (
            <Command.Group heading="Threads" className={PALETTE_GROUP_CLASS}>
              {chronologicalSessions.map((sessionItem) => (
                <ThreadPaletteRow
                  key={sessionItem.sessionId}
                  session={sessionItem}
                  threadFold={threadMap[sessionItem.sessionId]?.fold ?? null}
                  lastSeenTimestamp={lastSeenMap[sessionItem.sessionId] ?? null}
                  baselineCommit={baselineCommit}
                  nowTime={currentTime}
                  onActivate={() => handleSelect(() => controller.openThread(sessionItem.sessionId))}
                />
              ))}
            </Command.Group>
          )}
          {projectList.length > 0 && (
            <Command.Group heading="Projects" className={PALETTE_GROUP_CLASS}>
              {projectList.map((projectItem) => (
                <ProjectPaletteRow
                  key={projectItem.cwd}
                  project={projectItem}
                  onActivate={() => handleSelect(() => controller.newThread(projectItem.cwd))}
                />
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </Modal>
  );
}
