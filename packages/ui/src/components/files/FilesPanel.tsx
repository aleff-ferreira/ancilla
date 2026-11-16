import {
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  CaretRightIcon,
  CodeIcon,
  EyeIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileTxtIcon,
  FileVideoIcon,
  FolderIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
  TreeViewIcon,
  XIcon,
} from "../ui/icons.js";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type ChangeEvent,
} from "react";
import { shallowEqual, useApp, useController } from "../../app/context.js";
import { useOverlayDragProps } from "../../app/frame.js";
import { errorKind, errorMessage } from "../../client.js";
import {
  basenameOf,
  dirnameOf,
  fileKey,
  fileTarget,
  formatFileSize,
  isMarkdownPath,
  type LineRange,
} from "../../model/files.js";
import { DEFAULT_FILES_WIDTH } from "../../model/store.js";
import type { FileContent, FileEntry } from "../../types.js";
import { FileLinksContext, Markdown, languageFromPath, type FileLinks } from "../ui/Markdown.js";

const useClientLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
import { Tip } from "../ui/overlays.js";
import { Button, IconButton, Spinner, cn } from "../ui/primitives.js";
import { highlight } from "sugar-high";
import type { AncillaController } from "../../model/controller.js";

const MAX_HIGHLIGHT_SOURCE_CHARS = 300_000;
const TREE_ITEM_ROW_CLASS = "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-sm transition-colors hover:bg-hover";

interface FetchFailureState {
  errorMessageText: string;
  failureKind: string | null;
}

const KNOWN_FILE_EXTENSIONS = {
  img: new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp"]),
  vid: new Set(["mp4", "webm", "mov", "m4v", "ogv"]),
  snd: new Set(["mp3", "wav", "ogg", "m4a", "flac"]),
};

function getFileGlyph(targetPath: string): ReactNode {
  const dotPosition = targetPath.lastIndexOf(".");
  const ext = dotPosition >= 0 ? targetPath.slice(dotPosition + 1).toLowerCase() : "";

  if (isMarkdownPath(targetPath) || ext === "txt") return <FileTextIcon size={14} />;
  if (KNOWN_FILE_EXTENSIONS.img.has(ext)) return <FileImageIcon size={14} />;
  if (KNOWN_FILE_EXTENSIONS.vid.has(ext)) return <FileVideoIcon size={14} />;
  if (KNOWN_FILE_EXTENSIONS.snd.has(ext)) return <FileAudioIcon size={14} />;
  if (ext === "pdf") return <FileTxtIcon size={14} />;

  const detected = languageFromPath(targetPath);
  return detected ? <FileCodeIcon size={14} /> : <FileIcon size={14} />;
}

export function FilesPanel(props: { sessionId: string; cwd: string }) {
  const controller = useController();
  const filesPanelWidth = useApp((state) => state.prefs.filesWidth);
  const activeSessionPanel = useApp((state) => state.filePanels[props.sessionId] ?? null, shallowEqual);
  const currentDrafts = useApp((state) => state.fileDrafts);

  const dragSurface = useOverlayDragProps();
  const omitDrag = useOverlayDragProps("off");

  const openedTabs = activeSessionPanel?.tabs ?? [];
  const activeFilePath = activeSessionPanel?.active ?? null;
  const isTreeActive = !activeSessionPanel || activeSessionPanel.tree || !activeFilePath;

  const handleTabDismiss = (pathToRemove: string) => {
    const targetKey = fileKey(props.cwd, pathToRemove);
    const hasUnsavedDraft = currentDrafts[targetKey];
    if (hasUnsavedDraft && !window.confirm(`Discard your unsaved changes to ${basenameOf(pathToRemove)}?`)) {
      return;
    }
    controller.closeFile(props.sessionId, pathToRemove);
  };

  return (
    <aside
      aria-label="Files"
      style={{ width: `min(${filesPanelWidth}px, 70%)` }}
      className="relative flex h-full shrink-0 flex-col border-l border-line bg-bg"
    >
      <ResizeHandle />
      <header
        data-drag-region
        {...dragSurface}
        className="flex h-12 shrink-0 items-center gap-1 border-b border-line pr-2 pl-2"
      >
        <Tip label={isTreeActive ? "Back to the open file" : "Show files"}>
          <IconButton
            size="md"
            label={isTreeActive ? "Back to the open file" : "Show files"}
            disabled={isTreeActive && !activeFilePath}
            active={isTreeActive}
            onClick={() => controller.showFileTree(props.sessionId, !isTreeActive)}
            {...omitDrag}
            children={<TreeViewIcon size={15} />}
          />
        </Tip>

        <FileTabsBar
          tabs={openedTabs}
          activePath={activeFilePath}
          treeShown={isTreeActive}
          draftsMap={currentDrafts}
          cwd={props.cwd}
          onActivate={(p) => controller.activateFile(props.sessionId, p)}
          onClose={handleTabDismiss}
          dragProps={omitDrag}
        />

        <Tip label="Close files">
          <IconButton
            size="md"
            label="Close files"
            onClick={() => controller.toggleFiles(false)}
            {...omitDrag}
            children={<XIcon size={15} />}
          />
        </Tip>
      </header>

      <main className="min-h-0 flex-1">
        {isTreeActive ? (
          <FileTree sessionId={props.sessionId} cwd={props.cwd} />
        ) : activeFilePath ? (
          <FileView
            key={activeFilePath}
            sessionId={props.sessionId}
            cwd={props.cwd}
            path={activeFilePath}
            line={activeSessionPanel?.line ?? null}
          />
        ) : null}
      </main>
    </aside>
  );
}

function FileTabItem({
  path,
  isActive,
  isDirty,
  onActivate,
  onClose,
}: {
  path: string;
  isActive: boolean;
  isDirty: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const label = basenameOf(path);
  return (
    <div
      role="tab"
      aria-selected={isActive}
      title={path}
      className={cn(
        "group/tab flex h-7 max-w-[200px] shrink-0 items-center gap-1 rounded-md pr-0.5 pl-2 text-xs transition-colors duration-100",
        isActive ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        className="flex min-w-0 items-center gap-1.5 text-left"
      >
        <span className="shrink-0 text-subtle">{getFileGlyph(path)}</span>
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        aria-label={isDirty ? `${label} has unsaved changes. Close` : `Close ${label}`}
        onClick={onClose}
        className="flex size-5 shrink-0 items-center justify-center rounded text-subtle hover:bg-hover hover:text-fg"
      >
        {isDirty ? (
          <span className="size-1.5 rounded-full bg-accent group-hover/tab:hidden" />
        ) : null}
        <XIcon size={12} className={cn(isDirty && "hidden group-hover/tab:block")} />
      </button>
    </div>
  );
}

function FileTabsBar({
  tabs,
  activePath,
  treeShown,
  draftsMap,
  cwd,
  onActivate,
  onClose,
  dragProps,
}: {
  tabs: readonly string[];
  activePath: string | null;
  treeShown: boolean;
  draftsMap: Readonly<Record<string, unknown>>;
  cwd: string;
  onActivate: (p: string) => void;
  onClose: (p: string) => void;
  dragProps: Record<string, unknown>;
}) {
  return (
    <nav
      role="tablist"
      aria-label="Open files"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      {...dragProps}
    >
      {tabs.map((tabPath) => (
        <FileTabItem
          key={tabPath}
          path={tabPath}
          isActive={tabPath === activePath && !treeShown}
          isDirty={Boolean(draftsMap[fileKey(cwd, tabPath)])}
          onActivate={() => onActivate(tabPath)}
          onClose={() => onClose(tabPath)}
        />
      ))}
    </nav>
  );
}

function useFilesSplitter(ctrl: AncillaController) {
  const handlePointerDown = (evt: PointerEvent<HTMLDivElement>) => {
    evt.preventDefault();
    const handleNode = evt.currentTarget;
    const clickX = evt.clientX;
    const baseW = ctrl.store.get().prefs.filesWidth;
    handleNode.setPointerCapture(evt.pointerId);
    document.body.style.cursor = "col-resize";

    const onPointerMove = (moveEvt: globalThis.PointerEvent) => {
      const offsetX = moveEvt.clientX - clickX;
      ctrl.setFilesWidth(baseW - offsetX);
    };

    const onPointerUp = () => {
      handleNode.removeEventListener("pointermove", onPointerMove);
      handleNode.removeEventListener("pointerup", onPointerUp);
      handleNode.removeEventListener("pointercancel", onPointerUp);
      document.body.style.cursor = "";
    };

    handleNode.addEventListener("pointermove", onPointerMove);
    handleNode.addEventListener("pointerup", onPointerUp);
    handleNode.addEventListener("pointercancel", onPointerUp);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const curWidth = ctrl.store.get().prefs.filesWidth;
    if (event.key === "ArrowLeft") {
      ctrl.setFilesWidth(curWidth + 16);
    } else if (event.key === "ArrowRight") {
      ctrl.setFilesWidth(curWidth - 16);
    }
  };

  const handleDoubleClick = () => {
    ctrl.setFilesWidth(DEFAULT_FILES_WIDTH);
  };

  return { handlePointerDown, handleKeyDown, handleDoubleClick };
}

function ResizeHandle() {
  const ctrl = useController();
  const { handlePointerDown, handleKeyDown, handleDoubleClick } = useFilesSplitter(ctrl);

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize files"
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
      className="absolute top-0 left-[-3px] z-[var(--z-resize)] h-full w-1.5 cursor-col-resize transition-colors duration-150 hover:bg-brand/35 focus-visible:bg-focus focus-visible:outline-none"
    />
  );
}

function FileSearchInput({
  query,
  isPending,
  onQueryChange,
  onEscape,
  onActivateFirst,
}: {
  query: string;
  isPending: boolean;
  onQueryChange: (val: string) => void;
  onEscape: () => void;
  onActivateFirst: () => void;
}) {
  return (
    <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-sunken px-2 text-sm shadow-[0_0_0_1px_var(--border)] focus-within:shadow-[0_0_0_1px_var(--focus-ring)]">
      {isPending ? (
        <Spinner size={12} className="shrink-0" />
      ) : (
        <MagnifyingGlassIcon size={13} className="shrink-0 text-subtle" />
      )}
      <input
        value={query}
        aria-label="Find a file"
        placeholder="Find a file"
        className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-subtle"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onEscape();
          else if (e.key === "Enter") onActivateFirst();
        }}
      />
    </div>
  );
}

function FileTree(props: { sessionId: string; cwd: string }) {
  const ctrl = useController();
  const [filterQuery, setFilterQuery] = useState("");
  const [matchingEntries, setMatchingEntries] = useState<FileEntry[] | null>(null);
  const [filterPending, setFilterPending] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);

  useEffect(() => {
    const cleanWord = filterQuery.trim();
    if (!cleanWord) {
      setMatchingEntries(null);
      return;
    }
    let isLive = true;
    setFilterPending(true);
    const delayHandle = window.setTimeout(() => {
      ctrl
        .searchFiles(props.cwd, cleanWord)
        .then((items) => {
          if (isLive) setMatchingEntries(items);
        })
        .catch(() => {
          if (isLive) setMatchingEntries([]);
        })
        .finally(() => {
          if (isLive) setFilterPending(false);
        });
    }, 160);

    return () => {
      isLive = false;
      window.clearTimeout(delayHandle);
    };
  }, [ctrl, props.cwd, filterQuery]);

  const renderTreeContent = () => {
    if (matchingEntries) {
      if (matchingEntries.length === 0 && !filterPending) {
        return <div className="px-3 py-6 text-center text-sm text-muted">No files match.</div>;
      }
      return matchingEntries.map((row) => (
        <button
          key={row.path}
          type="button"
          onClick={() => ctrl.openFile(props.sessionId, row.path)}
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-hover"
        >
          <span className="shrink-0 text-subtle">{getFileGlyph(row.name)}</span>
          <span className="min-w-0 truncate text-fg">{row.name}</span>
          <span className="min-w-0 truncate text-xs text-subtle">{dirnameOf(row.path)}</span>
        </button>
      ));
    }
    return <TreeFolder key={refreshCounter} sessionId={props.sessionId} cwd={props.cwd} path="" depth={0} />;
  };

  return (
    <section className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <FileSearchInput
            query={filterQuery}
            isPending={filterPending}
            onQueryChange={setFilterQuery}
            onEscape={() => setFilterQuery("")}
            onActivateFirst={() => {
              if (matchingEntries?.[0]) ctrl.openFile(props.sessionId, matchingEntries[0].path);
            }}
          />
          <Tip label="Refresh">
            <IconButton
              size="sm"
              label="Refresh files"
              onClick={() => setRefreshCounter((cnt) => cnt + 1)}
              children={<ArrowsClockwiseIcon size={13} />}
            />
          </Tip>
        </div>
      </header>

      <section role="tree" aria-label="Project files" className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {renderTreeContent()}
      </section>
    </section>
  );
}

function TreeFolder(props: { sessionId: string; cwd: string; path: string; depth: number }) {
  const ctrl = useController();
  const [directoryItems, setDirectoryItems] = useState<FileEntry[] | null>(null);
  const [loadErrorMsg, setLoadErrorMsg] = useState<string | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    let activePoll = true;
    ctrl
      .listFiles(props.cwd, props.path)
      .then((payload) => {
        if (activePoll) {
          setDirectoryItems(payload.entries);
          setHasOverflow(payload.truncated);
        }
      })
      .catch((err: unknown) => {
        if (activePoll) setLoadErrorMsg(errorMessage(err));
      });

    return () => {
      activePoll = false;
    };
  }, [ctrl, props.cwd, props.path]);

  const insetStyle = { paddingLeft: `${props.depth * 12 + 6}px` };

  if (loadErrorMsg) {
    return (
      <p className="py-1 text-xs text-danger-text" style={insetStyle}>
        {loadErrorMsg}
      </p>
    );
  }

  if (!directoryItems) {
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-subtle" style={insetStyle}>
        <Spinner size={10} /> Loading
      </div>
    );
  }

  if (directoryItems.length === 0 && props.depth === 0) {
    return (
      <div className="px-3 py-6 text-center text-sm text-muted">
        This folder is empty.
      </div>
    );
  }

  return (
    <div role="group" className="tree-branch">
      {directoryItems.map((entry) => {
        if (entry.kind === "dir") {
          return <TreeDir key={entry.path} {...props} entry={entry} />;
        }
        return (
          <TreeFile
            key={entry.path}
            sessionId={props.sessionId}
            cwd={props.cwd}
            entry={entry}
            depth={props.depth}
          />
        );
      })}
      {hasOverflow && (
        <p className="py-1 text-2xs text-subtle" style={insetStyle}>
          More files here than the tree lists. Find one by name above.
        </p>
      )}
    </div>
  );
}

function TreeDir(props: { sessionId: string; cwd: string; entry: FileEntry; depth: number }) {
  const ctrl = useController();
  const isBranchOpen = useApp((st) => (st.fileTreeOpen[props.cwd] ?? []).includes(props.entry.path));
  const FolderIconComponent = isBranchOpen ? FolderOpenIcon : FolderIcon;
  const leftPad = props.depth * 12 + 4;

  const handleToggle = () => {
    ctrl.toggleTreeFolder(props.cwd, props.entry.path);
  };

  return (
    <div role="treeitem" aria-expanded={isBranchOpen}>
      <button
        type="button"
        style={{ paddingLeft: `${leftPad}px` }}
        onClick={handleToggle}
        className={cn(
          TREE_ITEM_ROW_CLASS,
          props.entry.name[0] === "." ? "text-subtle" : "text-fg",
        )}
      >
        <CaretRightIcon
          size={12}
          className={cn(
            "shrink-0 text-subtle transition-transform duration-150",
            isBranchOpen ? "rotate-90" : "rotate-0",
          )}
        />
        <FolderIconComponent size={14} className="shrink-0 text-subtle" />
        <span className="truncate">{props.entry.name}</span>
      </button>
      {isBranchOpen ? (
        <TreeFolder
          sessionId={props.sessionId}
          cwd={props.cwd}
          path={props.entry.path}
          depth={props.depth + 1}
        />
      ) : null}
    </div>
  );
}

function TreeFile(props: { sessionId: string; cwd: string; entry: FileEntry; depth: number }) {
  const ctrl = useController();
  const isHighlighted = useApp((st) => st.filePanels[props.sessionId]?.active === props.entry.path);
  const leftPadding = props.depth * 12 + 22;

  const handleOpenFile = () => {
    ctrl.openFile(props.sessionId, props.entry.path);
  };

  return (
    <button
      role="treeitem"
      type="button"
      aria-current={isHighlighted ? "true" : undefined}
      style={{ paddingLeft: `${leftPadding}px` }}
      onClick={handleOpenFile}
      className={cn(
        TREE_ITEM_ROW_CLASS,
        isHighlighted ? "bg-active text-fg" : props.entry.name[0] === "." ? "text-subtle" : "text-fg",
      )}
    >
      <span className="shrink-0 text-subtle">{getFileGlyph(props.entry.name)}</span>
      <span className="min-w-0 flex-1 truncate">{props.entry.name}</span>
      <span className="shrink-0 tabular-nums text-2xs text-subtle">{formatFileSize(props.entry.size)}</span>
    </button>
  );
}

function FileView(props: {
  sessionId: string;
  cwd: string;
  path: string;
  line: LineRange | null;
}) {
  const ctrl = useController();
  const fileHashKey = fileKey(props.cwd, props.path);
  const fileRevision = useApp((st) => st.fileVersions[fileHashKey] ?? 0);
  const unsavedDraft = useApp((st) => st.fileDrafts[fileHashKey] ?? null);
  const saveOperationPending = useApp((st) => Boolean(st.busy[`save:${fileHashKey}`]));

  const [documentContent, setDocumentContent] = useState<FileContent | null>(null);
  const [fetchFailure, setFetchFailure] = useState<FetchFailureState | null>(null);

  const isMarkdownFile = isMarkdownPath(props.path);
  const [showRawSource, setShowRawSource] = useState(() => !isMarkdownFile || unsavedDraft !== null);

  useEffect(() => {
    let isCurrent = true;
    setFetchFailure(null);

    ctrl
      .readFile(props.cwd, props.path)
      .then((data) => {
        if (isCurrent) setDocumentContent(data);
      })
      .catch((err: unknown) => {
        if (isCurrent) {
          setFetchFailure({
            errorMessageText: errorMessage(err),
            failureKind: errorKind(err),
          });
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [ctrl, props.cwd, props.path, fileRevision]);

  const triggerFileSave = () => {
    void ctrl.saveFile(props.cwd, props.path);
  };

  const navLinksContext = useMemo<FileLinks>(() => {
    const parentDir = dirnameOf(props.path);
    return {
      resolve: (href) => fileTarget(href, props.cwd, parentDir),
      open: ({ path: targetPath, line: targetLine }) =>
        ctrl.openFile(props.sessionId, targetPath, targetLine),
      imageUrl: (src) => {
        const dest = fileTarget(src, props.cwd, parentDir);
        return dest ? ctrl.fileUrl(props.cwd, dest.path) : null;
      },
    };
  }, [ctrl, props.cwd, props.path, props.sessionId]);

  const pathParts = props.path.split("/");
  const isEditableMd = isMarkdownFile && documentContent?.kind === "markdown" && !documentContent.truncated;

  return (
    <div className="flex h-full flex-col file-view-root">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-3">
        <nav aria-label="Path" className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-xs text-subtle">
          {pathParts.map((part, index) => {
            const isLastCrumb = index === pathParts.length - 1;
            const divider = index > 0 ? <span className="text-line-strong">/</span> : null;
            return (
              <span
                key={index}
                className={cn("flex min-w-0 items-center gap-1", isLastCrumb ? "shrink-0 text-fg" : "truncate")}
              >
                {divider}
                <span className="truncate">{part}</span>
              </span>
            );
          })}
        </nav>

        {unsavedDraft ? (
          <Button
            size="sm"
            variant="accent"
            className="h-6 px-2 text-xs"
            loading={saveOperationPending}
            onClick={triggerFileSave}
          >
            Save
          </Button>
        ) : null}

        {isEditableMd ? (
          <ViewToggleControls isSource={showRawSource} onToggle={setShowRawSource} />
        ) : null}

        {documentContent && documentContent.kind !== "text" && documentContent.kind !== "markdown" ? (
          <Tip label="Open in the default app">
            <IconButton
              size="sm"
              label="Open in the default app"
              onClick={() => void ctrl.openFileExternally(props.cwd, props.path)}
              children={<ArrowSquareOutIcon size={13} />}
            />
          </Tip>
        ) : null}
      </header>

      <section className="min-h-0 flex-1 overflow-auto document-scroll-area">
        {fetchFailure ? (
          <EmptyOrProblemState
            headline={fetchFailure.failureKind === null && /does not exist/.test(fetchFailure.errorMessageText) ? "This file is not there" : "Could not open this file"}
            explanation={fetchFailure.errorMessageText}
            retryCallback={() =>
              ctrl.store.set((state) => ({
                ...state,
                fileVersions: { ...state.fileVersions, [fileHashKey]: fileRevision + 1 },
              }))
            }
          />
        ) : !documentContent ? (
          <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted">
            <Spinner size={13} />
            <span>Opening</span>
          </div>
        ) : (
          <DocumentDispatcher
            doc={documentContent}
            cwd={props.cwd}
            focusLine={props.line}
            showSource={showRawSource}
            draftText={unsavedDraft?.content ?? null}
            linkResolver={navLinksContext}
            onContentChange={(updated) =>
              ctrl.setFileDraft(
                props.cwd,
                props.path,
                updated === documentContent.content ? null : updated,
                documentContent.mtimeMs,
              )
            }
            onCommit={triggerFileSave}
          />
        )}
      </section>
    </div>
  );
}

function ViewToggleControls({
  isSource,
  onToggle,
}: {
  isSource: boolean;
  onToggle: (source: boolean) => void;
}) {
  return (
    <div role="radiogroup" aria-label="View" className="flex items-center rounded-md bg-sunken p-0.5">
      <Tip label="Preview">
        <button
          type="button"
          role="radio"
          aria-checked={!isSource}
          aria-label="Preview"
          onClick={() => onToggle(false)}
          className={cn(
            "flex h-5 w-6 items-center justify-center rounded transition-colors duration-100",
            !isSource ? "bg-raised text-fg shadow-btn" : "text-subtle hover:text-fg",
          )}
        >
          <EyeIcon size={13} />
        </button>
      </Tip>
      <Tip label="Source">
        <button
          type="button"
          role="radio"
          aria-checked={isSource}
          aria-label="Source"
          onClick={() => onToggle(true)}
          className={cn(
            "flex h-5 w-6 items-center justify-center rounded transition-colors duration-100",
            isSource ? "bg-raised text-fg shadow-btn" : "text-subtle hover:text-fg",
          )}
        >
          <CodeIcon size={13} />
        </button>
      </Tip>
    </div>
  );
}

function EmptyOrProblemState({
  headline,
  explanation,
  retryCallback,
}: {
  headline: string;
  explanation: string;
  retryCallback?: () => void;
}) {
  return (
    <section className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium text-fg">{headline}</p>
      <p className="max-w-[46ch] text-xs text-pretty text-muted">{explanation}</p>
      {retryCallback ? (
        <Button size="sm" variant="ghost" onClick={retryCallback}>
          <ArrowsClockwiseIcon size={13} />
          <span>Try again</span>
        </Button>
      ) : null}
    </section>
  );
}

function DocumentDispatcher(props: {
  doc: FileContent;
  cwd: string;
  focusLine: LineRange | null;
  showSource: boolean;
  draftText: string | null;
  linkResolver: FileLinks;
  onContentChange: (val: string) => void;
  onCommit: () => void;
}) {
  const ctrl = useController();
  const file = props.doc;
  const assetUri = ctrl.fileUrl(props.cwd, file.path);

  if (file.kind === "markdown") {
    if (props.showSource) {
      if (file.truncated) {
        return <SourceView text={file.content ?? ""} path={file.path} line={props.focusLine} truncated />;
      }
      return (
        <SourceEditor
          value={props.draftText ?? file.content ?? ""}
          onChange={props.onContentChange}
          onSave={props.onCommit}
        />
      );
    }
    return (
      <div className="px-6 py-5">
        <FileLinksContext.Provider value={props.linkResolver}>
          <Markdown text={props.draftText ?? file.content ?? ""} className="mx-auto max-w-[72ch]" />
        </FileLinksContext.Provider>
      </div>
    );
  }

  if (file.kind === "text") {
    return (
      <SourceView
        text={file.content ?? ""}
        path={file.path}
        line={props.focusLine}
        truncated={file.truncated}
      />
    );
  }

  if (file.kind === "image") {
    return (
      <div className="file-checker flex min-h-full items-center justify-center p-6">
        <img
          src={assetUri}
          alt={file.name}
          className="max-h-full max-w-full object-contain shadow-card"
        />
      </div>
    );
  }

  if (file.kind === "video") {
    return (
      <div className="flex min-h-full items-center justify-center bg-black p-4">
        <video
          src={assetUri}
          controls
          preload="metadata"
          className="max-h-full max-w-full"
        />
      </div>
    );
  }

  if (file.kind === "audio") {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6">
        <FileAudioIcon size={28} className="text-subtle" />
        <audio src={assetUri} controls preload="metadata" className="w-full max-w-md" />
      </div>
    );
  }

  if (file.kind === "pdf") {
    return (
      <iframe
        src={assetUri}
        title={file.name}
        className="h-full w-full border-0 bg-white"
      />
    );
  }

  return (
    <EmptyOrProblemState
      headline="No preview for this file"
      explanation={`${file.name} is a ${formatFileSize(file.size)} binary file. Open it in the app your system uses for it.`}
    />
  );
}

function SourceView({
  text,
  path,
  line,
  truncated,
}: {
  text: string;
  path: string;
  line: LineRange | null;
  truncated?: boolean;
}) {
  const codeNodeRef = useRef<HTMLElement>(null);
  const [lineWrapEnabled, setLineWrapEnabled] = useState(false);

  const formattedHtml = useMemo(() => {
    const fileLanguage = languageFromPath(path);
    const contentText = text.endsWith("\n") ? text.slice(0, -1) : text;

    if (fileLanguage && contentText.length <= MAX_HIGHLIGHT_SOURCE_CHARS) {
      try {
        const highlightedMarkup = highlight(contentText);
        return highlightedMarkup.replace(/<\/span>\n<span class="sh__line">/g, '</span><span class="sh__line">');
      } catch {
        // Fall back to plain escaped lines
      }
    }

    const segments: string[] = [];
    for (const rawLine of contentText.split("\n")) {
      const sanitized = rawLine
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      segments.push(`<span class="sh__line">${sanitized}</span>`);
    }
    return segments.join("");
  }, [text, path]);

  useClientLayoutEffect(() => {
    const rootContainer = codeNodeRef.current;
    if (!rootContainer) return;

    const spanRows = rootContainer.querySelectorAll<HTMLElement>(".sh__line");
    spanRows.forEach((row) => row.removeAttribute("data-marked"));

    if (!line) return;

    const startIndex = line.start - 1;
    const boundaryIndex = Math.min(line.end, spanRows.length);

    for (let i = startIndex; i < boundaryIndex; i++) {
      spanRows[i]?.setAttribute("data-marked", "");
    }

    spanRows[startIndex]?.scrollIntoView({ block: "center" });
  }, [formattedHtml, line]);

  return (
    <div className="relative min-h-full">
      <header className="sticky top-0 z-[1] flex justify-end px-2 pt-1.5">
        <button
          type="button"
          aria-pressed={lineWrapEnabled}
          onClick={() => setLineWrapEnabled((prev) => !prev)}
          className="rounded bg-sunken/90 px-1.5 py-0.5 text-2xs text-subtle backdrop-blur hover:text-fg"
        >
          {lineWrapEnabled ? "No wrap" : "Wrap"}
        </button>
      </header>
      <pre className="-mt-6 overflow-x-auto pt-1 pb-6">
        <code
          ref={codeNodeRef}
          dangerouslySetInnerHTML={{ __html: formattedHtml }}
          className={cn("file-code block font-mono", lineWrapEnabled ? "wrap" : "")}
        />
      </pre>
      {truncated ? (
        <p className="border-t border-line px-4 py-2 text-xs text-subtle">
          This file is large, so only its start is shown.
        </p>
      ) : null}
    </div>
  );
}

function SourceEditor({
  value,
  onChange,
  onSave,
}: {
  value: string;
  onChange: (updatedVal: string) => void;
  onSave: () => void;
}) {
  const onEditorKeyDown = (evt: KeyboardEvent<HTMLTextAreaElement>) => {
    const isMacPlatform = navigator.platform.toLowerCase().includes("mac");
    const hasModifier = isMacPlatform ? evt.metaKey : evt.ctrlKey;

    if (hasModifier && evt.key.toLowerCase() === "s") {
      evt.preventDefault();
      onSave();
      return;
    }

    if (evt.key === "Tab" && !evt.shiftKey && !hasModifier && !evt.altKey) {
      evt.preventDefault();
      const area = evt.currentTarget;
      const { selectionStart: selStart, selectionEnd: selEnd, value: curVal } = area;
      const combined = `${curVal.slice(0, selStart)}  ${curVal.slice(selEnd)}`;
      onChange(combined);
      requestAnimationFrame(() => {
        area.setSelectionRange(selStart + 2, selStart + 2);
      });
    }
  };

  const handleTextChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
  };

  return (
    <textarea
      value={value}
      spellCheck={false}
      aria-label="Markdown source"
      onChange={handleTextChange}
      onKeyDown={onEditorKeyDown}
      className="block h-full min-h-full w-full resize-none bg-bg px-5 py-4 font-mono text-[12.5px] leading-[1.6] text-fg outline-none"
    />
  );
}
