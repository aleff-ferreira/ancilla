import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArrowElbowLeftUpIcon,
  ArrowLeftIcon,
  FolderIcon,
  FolderPlusIcon,
  LinkIcon,
} from "../ui/icons.js";
import { useApp, useController } from "../../app/context.js";
import { errorMessage } from "../../client.js";
import {
  cloneUrl,
  isFullPath,
  parentFolder,
  repoName,
  sameFolder,
  splitBrowsePath,
  withTrailingSeparator,
} from "../../model/paths.js";
import type { DirectoryListing } from "../../types.js";
import { Modal } from "../ui/overlays.js";
import { Kbd, MOD, Spinner, cn } from "../ui/primitives.js";

type RemoteProvider = "git" | "github";

type ProjectDialogStep =
  | { type: "sources" }
  | { type: "browse"; startingPath?: string }
  | { type: "remote"; provider: RemoteProvider }
  | { type: "destination"; targetUrl: string; repoFolderName: string };

const FIELD_INPUT_STYLE =
  "h-11 flex-1 min-w-0 bg-transparent text-[15px] text-fg outline-none placeholder:text-subtle";

export function AddProjectDialog(): JSX.Element {
  const ctrl = useController();
  const modalFlag = useApp((state) => state.addProjectOpen);
  const isOpen = modalFlag !== false;
  const parentFolderTarget = typeof modalFlag === "object" ? modalFlag.folderFor : null;

  return (
    <Modal
      open={isOpen}
      onOpenChange={(next) => ctrl.setAddProjectOpen(next)}
      title={parentFolderTarget ? "Add a folder to the project" : "Add a project"}
      className="top-[12vh] w-[min(640px,calc(100vw-32px))] overflow-hidden"
      hideTitle
      bare
    >
      {isOpen ? <ProjectWizardOrchestrator folderFor={parentFolderTarget} /> : null}
    </Modal>
  );
}

interface ProjectWizardOrchestratorProps {
  folderFor: string | null;
}

function ProjectWizardOrchestrator({ folderFor }: ProjectWizardOrchestratorProps): JSX.Element {
  const currentProjects = useApp((state) => state.projects);

  const [activeStep, setActiveStep] = useState<ProjectDialogStep>(() =>
    folderFor ? { type: "browse" } : { type: "sources" },
  );

  const [initialBaseDirectory] = useState(() => {
    if (folderFor) return parentFolder(folderFor) ?? "~/";
    if (currentProjects.length > 0 && currentProjects[0]?.cwd) {
      return parentFolder(currentProjects[0].cwd) ?? "~/";
    }
    return "~/";
  });

  const launchCloneFlow = (gitUrl: string): void => {
    setActiveStep({
      type: "destination",
      targetUrl: gitUrl,
      repoFolderName: repoName(gitUrl),
    });
  };

  if (folderFor) {
    return (
      <DirectoryBrowserView
        key="folder"
        initialPath={initialBaseDirectory}
        cloneSourceUrl={null}
        targetProjectCwd={folderFor}
      />
    );
  }

  if (activeStep.type === "sources") {
    return (
      <SourceSelectionStep
        onSelectSource={(sourceKey) => {
          if (sourceKey === "local") {
            setActiveStep({ type: "browse" });
          } else {
            setActiveStep({ type: "remote", provider: sourceKey });
          }
        }}
        onDirectPath={(folderPath) => setActiveStep({ type: "browse", startingPath: folderPath })}
        onStartClone={launchCloneFlow}
      />
    );
  }

  if (activeStep.type === "remote") {
    return (
      <RemoteRepositoryStep
        provider={activeStep.provider}
        onNavigateBack={() => setActiveStep({ type: "sources" })}
        onProceedWithUrl={launchCloneFlow}
      />
    );
  }

  if (activeStep.type === "destination") {
    return (
      <DirectoryBrowserView
        key="destination"
        initialPath={`${initialBaseDirectory}${activeStep.repoFolderName}`}
        cloneSourceUrl={activeStep.targetUrl}
        onNavigateBack={() => setActiveStep({ type: "sources" })}
      />
    );
  }

  return (
    <DirectoryBrowserView
      key="browse"
      initialPath={activeStep.startingPath ?? initialBaseDirectory}
      cloneSourceUrl={null}
      onNavigateBack={() => setActiveStep({ type: "sources" })}
    />
  );
}

function GitHubLogoIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true" className="shrink-0">
      <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  );
}

interface SourceOptionDescriptor {
  id: "local" | RemoteProvider;
  label: string;
  description: string;
  icon: ReactNode;
}

const KNOWN_SOURCES: readonly SourceOptionDescriptor[] = [
  {
    id: "local",
    label: "Local folder",
    description: "Browse a folder on disk",
    icon: <FolderPlusIcon size={17} />,
  },
  {
    id: "git",
    label: "Git URL",
    description: "Clone from a remote URL",
    icon: <LinkIcon size={17} />,
  },
  {
    id: "github",
    label: "GitHub repository",
    description: "Clone GitHub owner/repo",
    icon: <GitHubLogoIcon />,
  },
];

interface SourceSelectionStepProps {
  onSelectSource: (sourceId: "local" | RemoteProvider) => void;
  onDirectPath: (path: string) => void;
  onStartClone: (url: string) => void;
}

function SourceSelectionStep({
  onSelectSource,
  onDirectPath,
  onStartClone,
}: SourceSelectionStepProps): JSX.Element {
  const isWindows = useApp((state) => state.env?.platform === "win32");
  const [typedQuery, setTypedQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const optionListId = useId();

  const detectedClone = typedQuery.trim() ? cloneUrl(typedQuery) : null;

  interface SelectionRow {
    id: "local" | RemoteProvider | "clone";
    label: string;
    description: string;
    icon: ReactNode;
  }

  const selectionRows: SelectionRow[] = detectedClone
    ? [
        {
          id: "clone",
          label: `Clone ${detectedClone}`,
          description: "Next, pick where to clone it",
          icon: <LinkIcon size={17} />,
        },
      ]
    : [...KNOWN_SOURCES];

  const boundedIndex = Math.min(focusedIndex, selectionRows.length - 1);

  const triggerSelection = (rowId: SelectionRow["id"]): void => {
    if (rowId === "clone") {
      if (detectedClone) onStartClone(detectedClone);
    } else {
      onSelectSource(rowId);
    }
  };

  const handleInputKeyDown = (evt: KeyboardEvent<HTMLInputElement>): void => {
    if (evt.key === "ArrowDown") {
      evt.preventDefault();
      setFocusedIndex(Math.min(selectionRows.length - 1, boundedIndex + 1));
    } else if (evt.key === "ArrowUp") {
      evt.preventDefault();
      setFocusedIndex(Math.max(0, boundedIndex - 1));
    } else if (evt.key === "Enter") {
      evt.preventDefault();
      const item = selectionRows[boundedIndex];
      if (item) triggerSelection(item.id);
    }
  };

  const placeholderLabel = isWindows
    ? "Type a folder path like D:\\Projects, or paste a Git URL"
    : "Type a folder path like ~/code, or paste a Git URL";

  return (
    <>
      <DialogHeader icon={<FolderPlusIcon size={17} />}>
        <input
          autoFocus
          value={typedQuery}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholderLabel}
          aria-label="Folder path or Git URL"
          role="combobox"
          aria-expanded
          aria-controls={optionListId}
          aria-activedescendant={selectionRows[boundedIndex] ? `${optionListId}-${selectionRows[boundedIndex]?.id}` : undefined}
          onChange={(e) => {
            const val = e.currentTarget.value;
            if (isFullPath(val)) {
              onDirectPath(val);
              return;
            }
            setTypedQuery(val);
            setFocusedIndex(0);
          }}
          onKeyDown={handleInputKeyDown}
          className={FIELD_INPUT_STYLE}
        />
      </DialogHeader>

      <section className="p-1.5">
        <p className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-subtle">
          {detectedClone ? "Repository" : "Sources"}
        </p>

        <ul id={optionListId} role="listbox" aria-label={detectedClone ? "Repository" : "Sources"} className="list-none p-0 m-0">
          {selectionRows.map((rowItem, index) => (
            <li
              key={rowItem.id}
              id={`${optionListId}-${rowItem.id}`}
              role="option"
              aria-selected={index === boundedIndex}
              onMouseMove={() => setFocusedIndex(index)}
              onClick={() => triggerSelection(rowItem.id)}
              className={cn(
                "flex cursor-default items-center gap-3 rounded-lg px-2.5 py-2",
                index === boundedIndex && "bg-hover",
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center text-muted">
                {rowItem.icon}
              </span>
              <article className="flex-1 min-w-0">
                <span className="block truncate text-sm text-fg">{rowItem.label}</span>
                <span className="block text-xs text-muted">{rowItem.description}</span>
              </article>
            </li>
          ))}
        </ul>

        {typedQuery.trim() && !detectedClone && (
          <p className="px-2.5 py-2 text-xs text-muted">
            {isWindows
              ? "Start with a drive like D:\\ or with ~/ to browse folders."
              : "Start with / or ~/ to browse folders."}
          </p>
        )}
      </section>

      <DialogFooter
        hints={[
          { label: "Navigate", keys: ["↑", "↓"] },
          { label: "Select", keys: ["Enter"] },
          { label: "Close", keys: ["Esc"] },
        ]}
      />
    </>
  );
}

interface RemoteRepositoryStepProps {
  provider: RemoteProvider;
  onNavigateBack: () => void;
  onProceedWithUrl: (url: string) => void;
}

function RemoteRepositoryStep({
  provider,
  onNavigateBack,
  onProceedWithUrl,
}: RemoteRepositoryStepProps): JSX.Element {
  const [gitAddress, setGitAddress] = useState("");
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const normalizedUrl = cloneUrl(gitAddress);
  const isGitHubMode = provider === "github";

  const submitAddress = (): void => {
    setHasAttemptedSubmit(true);
    if (normalizedUrl) onProceedWithUrl(normalizedUrl);
  };

  return (
    <>
      <DialogHeader
        onBack={onNavigateBack}
        action={
          <ActionButton
            label="Continue"
            keys={["Enter"]}
            disabled={!normalizedUrl}
            onClick={submitAddress}
          />
        }
      >
        <input
          autoFocus
          value={gitAddress}
          spellCheck={false}
          autoComplete="off"
          aria-label={isGitHubMode ? "GitHub repository" : "Git URL"}
          placeholder={isGitHubMode ? "owner/repo" : "https://github.com/owner/repo.git"}
          onChange={(e) => setGitAddress(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitAddress();
            } else if (e.key === "Backspace" && gitAddress === "") {
              e.preventDefault();
              onNavigateBack();
            }
          }}
          className={FIELD_INPUT_STYLE}
        />
      </DialogHeader>

      <main className="px-4 py-5 text-sm">
        {hasAttemptedSubmit && !normalizedUrl ? (
          <p className="text-danger-text">
            {isGitHubMode
              ? "Type the repository in owner/repo format."
              : "That does not look like a Git URL or owner/repo format."}
          </p>
        ) : (
          <p className="leading-relaxed text-muted">
            {isGitHubMode
              ? "Type the repository in owner/repo format (private repos use Git credentials)."
              : "Paste an HTTPS or SSH repository URL, or owner/repo, then choose where to clone."}
          </p>
        )}
        {normalizedUrl && (
          <p className="mt-1.5 truncate font-mono text-xs text-subtle">{normalizedUrl}</p>
        )}
      </main>

      <DialogFooter
        hints={[
          { label: "Continue", keys: ["Enter"] },
          { label: "Back", keys: ["Backspace"] },
          { label: "Close", keys: ["Esc"] },
        ]}
      />
    </>
  );
}

type BrowserRowItem = { kind: "up"; path: string } | { kind: "folder"; name: string };

function useDirectoryListing(
  directory: string,
): { data: DirectoryListing | null; error: string | null; loading: boolean } {
  const ctrl = useController();
  const folderCache = useRef(new Map<string, DirectoryListing>());
  const [fsState, setFsState] = useState<{
    queryKey: string;
    data: DirectoryListing | null;
    error: string | null;
  }>({
    queryKey: "",
    data: null,
    error: null,
  });

  useEffect(() => {
    if (!directory) return;

    const hit = folderCache.current.get(directory);
    if (hit) {
      setFsState({ queryKey: directory, data: hit, error: null });
      return;
    }

    let activeFetch = true;
    ctrl.listDirectory(directory).then(
      (res) => {
        folderCache.current.set(directory, res);
        if (activeFetch) setFsState({ queryKey: directory, data: res, error: null });
      },
      (err: unknown) => {
        if (activeFetch) setFsState({ queryKey: directory, data: null, error: errorMessage(err) });
      },
    );

    return () => {
      activeFetch = false;
    };
  }, [directory, ctrl]);

  const isCurrentKey = fsState.queryKey === directory;
  return {
    data: isCurrentKey ? fsState.data : null,
    error: isCurrentKey ? fsState.error : null,
    loading: Boolean(directory) && !isCurrentKey,
  };
}

interface DirectoryBrowserViewProps {
  initialPath: string;
  cloneSourceUrl: string | null;
  targetProjectCwd?: string | null;
  onNavigateBack?: () => void;
}

function DirectoryBrowserRow({
  row,
  isHighlighted,
  leafPrefix,
  onSelect,
  onHighlight,
  id,
  index,
}: {
  row: BrowserRowItem;
  isHighlighted: boolean;
  leafPrefix: string;
  onSelect: () => void;
  onHighlight: () => void;
  id: string;
  index: number;
}) {
  const isUp = row.kind === "up";
  return (
    <li
      id={id}
      data-index={index}
      role="option"
      aria-selected={isHighlighted}
      onMouseMove={onHighlight}
      onClick={onSelect}
      className={cn(
        "flex h-9 cursor-default items-center gap-3 rounded-lg px-2.5 text-sm text-fg",
        isHighlighted && "bg-hover",
      )}
    >
      {isUp ? (
        <span className="inline-flex items-center gap-3 text-muted">
          <ArrowElbowLeftUpIcon size={16} className="shrink-0" />
          <span>..</span>
        </span>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-3 truncate">
          <FolderIcon size={16} className="shrink-0 text-muted" />
          <span className="truncate">
            <strong className="font-semibold">{row.name.slice(0, leafPrefix.length)}</strong>
            <span>{row.name.slice(leafPrefix.length)}</span>
          </span>
        </span>
      )}
    </li>
  );
}

function DirectoryBrowserView({
  initialPath,
  cloneSourceUrl,
  targetProjectCwd,
  onNavigateBack,
}: DirectoryBrowserViewProps): JSX.Element {
  const ctrl = useController();
  const loadedProjects = useApp((state) => state.projects);
  const targetProject = targetProjectCwd
    ? (loadedProjects.find((p) => p.cwd === targetProjectCwd) ?? null)
    : null;
  const currentPlatform = useApp((state) => state.env?.platform ?? "");
  const isOperationActive = useApp((state) =>
    Boolean(state.busy[cloneSourceUrl ? "cloneProject" : "addProject"]),
  );

  const [pathInputText, setPathInputText] = useState(initialPath);
  const [selectedRowIdx, setSelectedRowIdx] = useState(-1);
  const listboxElemId = useId();
  const inputDomRef = useRef<HTMLInputElement>(null);
  const listboxDomRef = useRef<HTMLUListElement>(null);
  const isWin = currentPlatform === "win32";

  const { directory, leaf, separator } = splitBrowsePath(pathInputText);
  const isRootValid = isFullPath(pathInputText);
  const listingResponse = useDirectoryListing(isRootValid ? directory : "");
  const activeListing = listingResponse.data;

  const folderRowItems = useMemo<BrowserRowItem[]>(() => {
    if (!activeListing) return [];

    const searchFragment = leaf.toLowerCase();
    const children = activeListing.entries
      .filter((e) => (leaf.startsWith(".") || !e.name.startsWith(".")) && e.name.toLowerCase().startsWith(searchFragment))
      .map((e): BrowserRowItem => ({ kind: "folder", name: e.name }));

    return activeListing.parent && !leaf
      ? [{ kind: "up", path: withTrailingSeparator(activeListing.parent, activeListing.separator) }, ...children]
      : children;
  }, [activeListing, leaf]);

  const resolvedTarget = useMemo(() => {
    if (!activeListing) return null;
    if (!leaf) return { path: activeListing.directory, exists: activeListing.exists };

    const matchingEntry = activeListing.entries.find((e) =>
      isWin ? e.name.toLowerCase() === leaf.toLowerCase() : e.name === leaf,
    );

    return {
      path: withTrailingSeparator(activeListing.directory, activeListing.separator) + (matchingEntry?.name ?? leaf),
      exists: Boolean(matchingEntry),
    };
  }, [activeListing, leaf, isWin]);

  const existingProjectMatch =
    !cloneSourceUrl && resolvedTarget
      ? targetProjectCwd
        ? targetProject && targetProject.folders.some((f) => sameFolder(f.cwd, resolvedTarget.path))
          ? targetProject
          : null
        : (loadedProjects.find((p) => p.folders.some((f) => sameFolder(f.cwd, resolvedTarget.path))) ?? null)
      : null;

  useEffect(() => {
    const el = inputDomRef.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    if (selectedRowIdx >= folderRowItems.length) {
      setSelectedRowIdx(folderRowItems.length - 1);
    }
  }, [folderRowItems.length, selectedRowIdx]);

  useEffect(() => {
    if (selectedRowIdx >= 0) {
      listboxDomRef.current
        ?.querySelector(`[data-index="${selectedRowIdx}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedRowIdx]);

  const openSelectedRow = (row: BrowserRowItem): void => {
    setPathInputText(row.kind === "up" ? row.path : `${directory}${row.name}${separator}`);
    setSelectedRowIdx(-1);
    inputDomRef.current?.focus();
  };

  const executeAddAction = (): void => {
    if (!resolvedTarget || isOperationActive) return;

    if (cloneSourceUrl) {
      void ctrl.cloneProject(cloneSourceUrl, resolvedTarget.path);
    } else if (targetProjectCwd) {
      if (!existingProjectMatch && resolvedTarget.exists) {
        void ctrl.addProjectFolder(targetProjectCwd, resolvedTarget.path);
      }
    } else if (existingProjectMatch) {
      ctrl.setAddProjectOpen(false);
      const matchedCwd =
        existingProjectMatch.folders.find((f) => sameFolder(f.cwd, resolvedTarget.path))?.cwd ??
        existingProjectMatch.cwd;
      ctrl.newThread(matchedCwd);
    } else {
      void ctrl.addProject(resolvedTarget.path, { create: !resolvedTarget.exists });
    }
  };

  const handleKeyNavigation = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedRowIdx((prev) => Math.min(folderRowItems.length - 1, prev + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedRowIdx((prev) => Math.max(-1, prev - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const currentSelection = selectedRowIdx >= 0 ? folderRowItems[selectedRowIdx] : undefined;
      if (currentSelection && !(e.metaKey || e.ctrlKey)) {
        openSelectedRow(currentSelection);
      } else {
        executeAddAction();
      }
    } else if (e.key === "Tab" && !e.shiftKey) {
      const matchCandidate =
        selectedRowIdx >= 0
          ? folderRowItems[selectedRowIdx]
          : leaf
            ? folderRowItems.find((r) => r.kind === "folder")
            : undefined;

      if (matchCandidate) {
        e.preventDefault();
        openSelectedRow(matchCandidate);
      }
    } else if (e.key === "Backspace" && pathInputText === "" && onNavigateBack) {
      e.preventDefault();
      onNavigateBack();
    }
  };

  const primaryBtnText = cloneSourceUrl
    ? "Clone"
    : targetProjectCwd
      ? existingProjectMatch
        ? "Already added"
        : "Add folder"
      : existingProjectMatch
        ? "Open"
        : resolvedTarget && !resolvedTarget.exists
          ? "Create & Add"
          : "Add";

  const isActionDisabled =
    !resolvedTarget ||
    (targetProjectCwd !== null && targetProjectCwd !== undefined && (Boolean(existingProjectMatch) || !resolvedTarget.exists));

  const hasRowFocus = selectedRowIdx >= 0;

  const revealLabelFormatted = isWin
    ? "Open in File Explorer"
    : currentPlatform === "darwin"
      ? "Open in Finder"
      : "Open in Files";

  let footerStatusFeedback: ReactNode = null;
  if (!isRootValid) {
    footerStatusFeedback = isWin
      ? "Type a full path, like D:\\Projects or ~/code."
      : "Type a full path, like ~/code or /srv/app.";
  } else if (listingResponse.error) {
    footerStatusFeedback = <span className="text-danger-text">{listingResponse.error}</span>;
  } else if (listingResponse.loading) {
    footerStatusFeedback = (
      <span className="flex items-center gap-2">
        <Spinner size={12} /> Loading folders
      </span>
    );
  } else if (targetProjectCwd && existingProjectMatch) {
    footerStatusFeedback = `This folder is already part of ${targetProject?.displayName ?? "the project"}.`;
  } else if (activeListing && !activeListing.exists) {
    footerStatusFeedback = cloneSourceUrl
      ? "This folder does not exist yet. Cloning creates it."
      : targetProjectCwd
        ? "This folder does not exist."
        : "This folder does not exist yet. Press Enter to create it and add it.";
  } else if (activeListing && folderRowItems.length === 0) {
    footerStatusFeedback = leaf
      ? cloneSourceUrl
        ? `Cloning creates ${leaf} here.`
        : targetProjectCwd
          ? `No folder starts with “${leaf}”.`
          : `No folder starts with “${leaf}”. Press Enter to create it.`
      : "No folders here.";
  }

  const pathPlaceholder = isWin ? "D:\\Projects\\my-app" : "~/code/my-app";

  return (
    <>
      <DialogHeader
        onBack={onNavigateBack}
        icon={<FolderPlusIcon size={17} />}
        action={
          <ActionButton
            label={primaryBtnText}
            keys={hasRowFocus ? [MOD, "Enter"] : ["Enter"]}
            busy={isOperationActive}
            disabled={isActionDisabled}
            onClick={executeAddAction}
          />
        }
      >
        <input
          ref={inputDomRef}
          autoFocus
          value={pathInputText}
          spellCheck={false}
          autoComplete="off"
          aria-label={cloneSourceUrl ? "Folder to clone into" : "Folder path"}
          role="combobox"
          aria-expanded
          aria-controls={listboxElemId}
          aria-autocomplete="list"
          aria-activedescendant={hasRowFocus ? `${listboxElemId}-${selectedRowIdx}` : undefined}
          placeholder={pathPlaceholder}
          onChange={(e) => {
            setPathInputText(e.currentTarget.value);
            setSelectedRowIdx(-1);
          }}
          onKeyDown={handleKeyNavigation}
          className={FIELD_INPUT_STYLE}
        />
      </DialogHeader>

      <section className="h-[min(22rem,55vh)] overflow-y-auto p-1.5">
        <p className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-subtle">
          {cloneSourceUrl
            ? "Clone into"
            : targetProject
              ? `Add a folder to ${targetProject.displayName}`
              : "Folders"}
        </p>

        <ul ref={listboxDomRef} id={listboxElemId} role="listbox" aria-label="Folders" className="list-none p-0 m-0">
          {folderRowItems.map((r, i) => (
            <DirectoryBrowserRow
              key={r.kind === "up" ? ".." : r.name}
              id={`${listboxElemId}-${i}`}
              index={i}
              row={r}
              leafPrefix={leaf}
              isHighlighted={i === selectedRowIdx}
              onHighlight={() => setSelectedRowIdx(i)}
              onSelect={() => openSelectedRow(r)}
            />
          ))}
        </ul>

        {footerStatusFeedback && (
          <p className="px-2.5 py-3 text-sm text-muted">{footerStatusFeedback}</p>
        )}
      </section>

      <DialogFooter
        hints={[
          { label: "Navigate", keys: ["↑", "↓"] },
          { label: hasRowFocus ? "Open folder" : primaryBtnText, keys: ["Enter"] },
          ...(onNavigateBack ? [{ label: "Back", keys: ["Backspace"] }] : []),
          { label: "Close", keys: ["Esc"] },
        ]}
        right={
          activeListing?.exists && (
            <button
              type="button"
              onClick={() => void ctrl.revealPath(activeListing.directory)}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              {revealLabelFormatted}
            </button>
          )
        }
      />
    </>
  );
}

interface DialogHeaderProps {
  onBack?: () => void;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}

function DialogHeader({ onBack, icon, action, children }: DialogHeaderProps): JSX.Element {
  return (
    <header className="flex h-14 items-center gap-2 border-b border-line pr-3 pl-2">
      {onBack ? (
        <button
          onClick={onBack}
          aria-label="Back"
          type="button"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <ArrowLeftIcon size={17} aria-hidden="true" />
        </button>
      ) : icon ? (
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center text-subtle">
          {icon}
        </span>
      ) : (
        <span className="w-2" />
      )}
      {children}
      {action}
    </header>
  );
}

interface ActionButtonProps {
  label: string;
  keys: string[];
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}

function ActionButton({
  label,
  keys,
  onClick,
  disabled,
  busy,
}: ActionButtonProps): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      type="button"
      className="flex h-8 shrink-0 items-stretch overflow-hidden rounded-lg text-xs font-medium shadow-btn transition-opacity disabled:opacity-50"
    >
      <span className="flex items-center gap-1.5 bg-raised px-2.5 text-fg">
        {busy && <Spinner size={11} />}
        <span>{label}</span>
      </span>
      <span className="flex items-center border-l border-line bg-sunken px-2 text-muted">
        {keys.join(" ")}
      </span>
    </button>
  );
}

interface DialogFooterProps {
  hints: { keys: string[]; label: string }[];
  right?: ReactNode;
}

function DialogFooter({ hints, right }: DialogFooterProps): JSX.Element {
  return (
    <footer className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-sunken px-4 py-2 text-xs text-muted">
      {hints.map((hint) => (
        <span key={hint.label} className="inline-flex items-center gap-1.5">
          <span className="flex gap-0.5">
            {hint.keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </span>
          <span>{hint.label}</span>
        </span>
      ))}
      <span className="flex-1" />
      {right}
    </footer>
  );
}
