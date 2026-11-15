import { useEffect, useState } from "react";
import { useController } from "../../app/context.js";
import { withTrailingSeparator } from "../../model/paths.js";
import type { DirectoryListing } from "../../types.js";
import { ArrowElbowLeftUpIcon, FolderIcon } from "../ui/icons.js";
import { Button } from "../ui/primitives.js";

/**
 * Where to save a download. The file is already waiting on the computer that runs Ancilla; nothing is written until a folder
 * is chosen and Save is pressed. The same form serves the person's own tab (in the pane) and a web task's download (in the
 * Tasks row and the browser's assistant bar).
 */

export function formatSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

export interface DownloadFormProps {
  name: string;
  size: number | null;
  origin: string;
  page?: string;
  /** Where it goes unless another folder is picked. */
  folder: string;
  rememberFolder?: boolean;
  warning: string | null;
  /** The assistant's file says so: it asked for nothing and picked nothing. */
  fromAssistant?: boolean;
  busy?: boolean;
  onSave(folder: string, rememberFolder?: boolean): void;
  onDont(): void;
  /** Opens a native OS folder picker on the local host when supported; falls back to the inline folder browser otherwise. */
  onPickNative?(currentFolder: string): Promise<{ supported: boolean; folder: string | null }>;
}

/** True when the UI is running in a local window on the same machine as the Ancilla server (so a native OS dialog appears here). */
export function isLocalBrowserHost(): boolean {
  if (typeof window === "undefined" || !window.location) return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export function DownloadForm(props: DownloadFormProps) {
  const [folder, setFolder] = useState(props.folder);
  const [picking, setPicking] = useState(false);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [nativeUnsupported, setNativeUnsupported] = useState(false);
  const canRemember = !props.fromAssistant && !props.warning;
  const [remember, setRemember] = useState(Boolean(props.rememberFolder));

  const chooseNative = async () => {
    if (!props.onPickNative || nativeBusy) return;
    setNativeBusy(true);
    try {
      const picked = await props.onPickNative(folder);
      if (!picked.supported) {
        setNativeUnsupported(true);
        setPicking(true);
      } else if (picked.folder) {
        setFolder(picked.folder);
        setPicking(false);
      }
    } catch {
      setPicking(true);
    } finally {
      setNativeBusy(false);
    }
  };

  return (
    <div role="group" aria-label="Save a download" className="w-full space-y-2 text-xs">
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{props.name}</p>
        <p className="text-muted [overflow-wrap:anywhere]">
          {formatSize(props.size)}
          {props.origin ? ` from ${props.origin}` : ""}
          {props.fromAssistant ? ", started by the assistant" : ""}
        </p>
      </div>
      {props.warning ? (
        <p role="alert" className="rounded-lg border border-warn/25 bg-warn-soft px-2.5 py-1.5 text-warn-text">
          {props.warning}
        </p>
      ) : null}
      <p className="text-muted">Save in a folder on the computer that runs Ancilla:</p>
      <div className="flex items-center gap-1.5">
        <span title={folder} className="min-w-0 flex-1 truncate rounded-lg border border-line bg-sunken px-2.5 py-1.5 font-mono text-[11px] text-fg">
          {folder}
        </span>
        {props.onPickNative && !nativeUnsupported ? (
          <Button size="xs" variant="secondary" disabled={props.busy || nativeBusy} onClick={() => void chooseNative()}>
            Choose folder…
          </Button>
        ) : null}
        <Button size="xs" variant="secondary" disabled={props.busy || nativeBusy} onClick={() => setPicking((v) => !v)}>
          Change
        </Button>
      </div>
      {picking ? (
        <FolderPicker
          start={folder}
          onPick={(path) => {
            setFolder(path);
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      ) : null}
      {canRemember ? (
        <label className="flex items-center gap-2 text-muted">
          <input type="checkbox" checked={remember} disabled={props.busy} onChange={(e) => setRemember(e.currentTarget.checked)} />
          <span>Always save downloads in this folder</span>
        </label>
      ) : null}
      <p className="text-subtle">Nothing is saved until you press Save.</p>
      <div className="flex flex-wrap gap-2 pt-0.5">
        <Button size="sm" variant="accent" disabled={props.busy || nativeBusy} onClick={() => props.onSave(folder, canRemember ? remember : undefined)}>
          Save
        </Button>
        <Button size="sm" variant="secondary" disabled={props.busy || nativeBusy} onClick={props.onDont}>
          Don&apos;t save
        </Button>
      </div>
    </div>
  );
}

/** A small folder browser over the server's folder list (the one the add-project picker uses). */
export function FolderPicker(props: { start: string; onPick(path: string): void; onCancel(): void }) {
  const controller = useController();
  const [path, setPath] = useState(props.start);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    controller
      .listDirectory(path)
      .then((next) => {
        if (live) {
          setListing(next);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "That folder cannot be listed.");
      });
    return () => {
      live = false;
    };
  }, [controller, path]);
  const here = listing?.directory ?? path;
  return (
    <div role="group" aria-label="Choose a folder" className="space-y-1 rounded border border-line bg-bg p-1.5">
      <div className="flex items-center gap-1">
        <Button size="xs" variant="ghost" disabled={!listing?.parent} aria-label="Up one folder" onClick={() => listing?.parent && setPath(listing.parent)}>
          <ArrowElbowLeftUpIcon size={14} />
        </Button>
        <span title={here} className="min-w-0 flex-1 truncate text-muted">
          {here}
        </span>
      </div>
      {error ? <p className="text-muted">{error}</p> : null}
      {listing && !listing.exists ? <p className="text-muted">That folder does not exist.</p> : null}
      <ul className="max-h-36 overflow-y-auto">
        {(listing?.entries ?? []).map((entry) => (
          <li key={entry.name}>
            <button type="button" onClick={() => listing && setPath(withTrailingSeparator(listing.directory, listing.separator) + entry.name)} className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-hover">
              <FolderIcon size={13} />
              <span className="min-w-0 truncate">{entry.name}</span>
            </button>
          </li>
        ))}
        {listing && listing.entries.length === 0 && listing.exists ? <li className="px-1.5 text-subtle">No folders inside.</li> : null}
      </ul>
      <div className="flex gap-1.5">
        <Button size="xs" variant="accent" disabled={!listing?.exists} onClick={() => props.onPick(here)}>
          Use this folder
        </Button>
        <Button size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The person's own tab: the question as a small dialog over the pane, like a script's dialog. */
export function DownloadBox(props: {
  download: { id: string; name: string; size: number | null; origin: string; page: string; folder: string; rememberFolder?: boolean; warning: string | null };
  onAnswer(accept: boolean, folder?: string, remember?: boolean): void;
  onPickNative?(currentFolder: string): Promise<{ supported: boolean; folder: string | null }>;
}) {
  const { download } = props;
  return (
    <div role="dialog" aria-modal="true" aria-label="Save this file" className="absolute inset-0 z-30 flex items-center justify-center bg-bg/65 p-4 backdrop-blur-[2px]">
      <div className="max-h-full w-full max-w-sm overflow-y-auto rounded-xl border border-line-strong/80 bg-raised p-4 shadow-panel">
        <h2 className="mb-2 text-xs font-semibold tracking-[0.02em] text-muted uppercase">Save this file?</h2>
        <DownloadForm
          key={download.id}
          name={download.name}
          size={download.size}
          origin={download.origin}
          folder={download.folder}
          rememberFolder={download.rememberFolder}
          warning={download.warning}
          onPickNative={props.onPickNative}
          onSave={(folder, remember) => props.onAnswer(true, folder, remember)}
          onDont={() => props.onAnswer(false)}
        />
      </div>
    </div>
  );
}

export interface UploadDirectoryView {
  directory: string;
  parent: string | null;
  separator: "/" | "\\";
  exists: boolean;
  folders: string[];
  files: Array<{ name: string; size: number }>;
}

export interface UploadFormProps {
  multiple: boolean;
  origin: string;
  page?: string;
  folder: string;
  fromAssistant?: boolean;
  busy?: boolean;
  onUpload(files: string[]): void;
  onCancel(): void;
  onPickNativeFiles?(currentFolder: string, multiple: boolean): Promise<{ supported: boolean; files: string[] | null }>;
}

export function UploadForm(props: UploadFormProps) {
  const [folder, setFolder] = useState(props.folder);
  const [files, setFiles] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [nativeUnsupported, setNativeUnsupported] = useState(false);

  const chooseNative = async () => {
    if (!props.onPickNativeFiles || nativeBusy) return;
    setNativeBusy(true);
    try {
      const picked = await props.onPickNativeFiles(folder, props.multiple);
      if (!picked.supported) {
        setNativeUnsupported(true);
        setBrowsing(true);
      } else if (picked.files && picked.files.length > 0) {
        setFiles(props.multiple ? picked.files : [picked.files[0]!]);
        const first = picked.files[0]!;
        const sepIdx = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
        if (sepIdx > 0) setFolder(first.slice(0, sepIdx));
        setBrowsing(false);
      }
    } catch {
      setBrowsing(true);
    } finally {
      setNativeBusy(false);
    }
  };

  const toggleFile = (filePath: string) => {
    if (!props.multiple) {
      setFiles([filePath]);
      setBrowsing(false);
      return;
    }
    setFiles((prev) => (prev.includes(filePath) ? prev.filter((f) => f !== filePath) : [...prev, filePath]));
  };

  return (
    <div role="group" aria-label="Choose files to upload" className="w-full space-y-2 text-xs">
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">
          {props.multiple ? "Choose files to upload" : "Choose a file to upload"}
        </p>
        <p className="text-muted [overflow-wrap:anywhere]">
          {props.origin ? `To ${props.origin}` : "To this page"}
          {props.page ? ` (“${props.page}”)` : ""}
          {props.fromAssistant ? ", opened by the assistant" : ""}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          title={files.length > 0 ? files.join(", ") : "No file chosen"}
          className="min-w-0 flex-1 truncate rounded-lg border border-line bg-sunken px-2.5 py-1.5 font-mono text-[11px] text-fg"
        >
          {files.length === 0 ? "No file chosen" : files.map((f) => f.split(/[\\/]/).pop() ?? f).join(", ")}
        </span>
        {props.onPickNativeFiles && !nativeUnsupported ? (
          <Button size="xs" variant="secondary" disabled={props.busy || nativeBusy} onClick={() => void chooseNative()}>
            {props.multiple ? "Choose files…" : "Choose file…"}
          </Button>
        ) : null}
        <Button size="xs" variant="secondary" disabled={props.busy || nativeBusy} onClick={() => setBrowsing((v) => !v)}>
          Browse
        </Button>
      </div>
      {browsing ? (
        <FilePicker
          start={folder}
          multiple={props.multiple}
          selected={files}
          onFolderChange={setFolder}
          onToggleFile={toggleFile}
          onDone={() => setBrowsing(false)}
        />
      ) : null}
      <p className="text-subtle">Nothing leaves your computer until you press Upload.</p>
      <div className="flex flex-wrap gap-2 pt-0.5">
        <Button size="sm" variant="accent" disabled={props.busy || nativeBusy || files.length === 0} onClick={() => props.onUpload(files)}>
          Upload
        </Button>
        <Button size="sm" variant="secondary" disabled={props.busy || nativeBusy} onClick={props.onCancel}>
          {props.fromAssistant ? "Don't" : "Cancel"}
        </Button>
      </div>
    </div>
  );
}

export function FilePicker(props: {
  start: string;
  multiple: boolean;
  selected: string[];
  onFolderChange(folder: string): void;
  onToggleFile(filePath: string): void;
  onDone(): void;
}) {
  const controller = useController();
  const [path, setPath] = useState(props.start);
  const [manual, setManual] = useState("");
  const [listing, setListing] = useState<UploadDirectoryView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!controller.hasBrowserHttp) return;
    let live = true;
    controller
      .browser<UploadDirectoryView>("GET", `/uploads/list?folder=${encodeURIComponent(path)}`)
      .then((next) => {
        if (live) {
          setListing(next);
          setError(null);
          if (next.exists) props.onFolderChange(next.directory);
        }
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "That folder cannot be listed.");
      });
    return () => {
      live = false;
    };
  }, [controller, path]);

  const here = listing?.directory ?? path;
  const sep = listing?.separator ?? (here.includes("\\") ? "\\" : "/");

  return (
    <div role="group" aria-label="Browse files" className="space-y-1.5 rounded border border-line bg-bg p-1.5">
      {controller.hasBrowserHttp ? (
        <>
          <div className="flex items-center gap-1">
            <Button size="xs" variant="ghost" disabled={!listing?.parent} aria-label="Up one folder" onClick={() => listing?.parent && setPath(listing.parent)}>
              <ArrowElbowLeftUpIcon size={14} />
            </Button>
            <span title={here} className="min-w-0 flex-1 truncate text-muted">
              {here}
            </span>
          </div>
          {error ? <p className="text-muted">{error}</p> : null}
          {listing && !listing.exists ? <p className="text-muted">That folder does not exist.</p> : null}
          <ul className="max-h-36 overflow-y-auto">
            {(listing?.folders ?? []).map((folderName) => (
              <li key={`dir-${folderName}`}>
                <button
                  type="button"
                  onClick={() => setPath(withTrailingSeparator(here, sep) + folderName)}
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-hover"
                >
                  <FolderIcon size={13} />
                  <span className="min-w-0 truncate">{folderName}</span>
                </button>
              </li>
            ))}
            {(listing?.files ?? []).map((file) => {
              const full = withTrailingSeparator(here, sep) + file.name;
              const chosen = props.selected.includes(full);
              return (
                <li key={`file-${file.name}`}>
                  <button
                    type="button"
                    aria-pressed={chosen}
                    onClick={() => props.onToggleFile(full)}
                    className={`flex w-full items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left hover:bg-hover ${chosen ? "bg-active font-medium" : ""}`}
                  >
                    <span className="min-w-0 truncate">{file.name}</span>
                    <span className="shrink-0 text-subtle">{formatSize(file.size)}</span>
                  </button>
                </li>
              );
            })}
            {listing && listing.exists && listing.folders.length === 0 && listing.files.length === 0 ? (
              <li className="px-1.5 text-subtle">No files in this folder.</li>
            ) : null}
          </ul>
        </>
      ) : null}
      <div className="flex items-center gap-1">
        <input
          aria-label="File path"
          placeholder="Or enter a full file path…"
          value={manual}
          onChange={(e) => setManual(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && manual.trim()) {
              e.preventDefault();
              props.onToggleFile(manual.trim());
              setManual("");
            }
          }}
          className="h-7 min-w-0 flex-1 rounded border border-line bg-sunken px-2 text-xs text-fg outline-none focus:border-focus"
        />
        <Button
          size="xs"
          variant="secondary"
          disabled={!manual.trim()}
          onClick={() => {
            props.onToggleFile(manual.trim());
            setManual("");
          }}
        >
          Add
        </Button>
      </div>
      {props.multiple ? (
        <div className="flex justify-end">
          <Button size="xs" variant="ghost" onClick={props.onDone}>
            Done
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function UploadBox(props: {
  upload: { id: string; tabId: string; multiple: boolean; origin: string; page: string; folder: string };
  onAnswer(accept: boolean, files?: string[]): void;
  onPickNativeFiles?(currentFolder: string, multiple: boolean): Promise<{ supported: boolean; files: string[] | null }>;
}) {
  const { upload } = props;
  return (
    <div role="dialog" aria-modal="true" aria-label="Upload a file" className="absolute inset-0 z-30 flex items-center justify-center bg-bg/65 p-4 backdrop-blur-[2px]">
      <div className="max-h-full w-full max-w-sm overflow-y-auto rounded-xl border border-line-strong/80 bg-raised p-4 shadow-panel">
        <h2 className="mb-2 text-xs font-semibold tracking-[0.02em] text-muted uppercase">{upload.multiple ? "Upload files?" : "Upload a file?"}</h2>
        <UploadForm
          key={upload.id}
          multiple={upload.multiple}
          origin={upload.origin}
          page={upload.page}
          folder={upload.folder}
          onPickNativeFiles={props.onPickNativeFiles}
          onUpload={(files) => props.onAnswer(true, files)}
          onCancel={() => props.onAnswer(false)}
        />
      </div>
    </div>
  );
}
