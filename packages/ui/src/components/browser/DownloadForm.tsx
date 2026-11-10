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
  warning: string | null;
  /** The assistant's file says so: it asked for nothing and picked nothing. */
  fromAssistant?: boolean;
  busy?: boolean;
  onSave(folder: string): void;
  onDont(): void;
}

export function DownloadForm(props: DownloadFormProps) {
  const [folder, setFolder] = useState(props.folder);
  const [picking, setPicking] = useState(false);
  return (
    <div role="group" aria-label="Save a download" className="w-full space-y-1.5 text-xs">
      <p className="font-medium text-fg [overflow-wrap:anywhere]">{props.name}</p>
      <p className="text-muted [overflow-wrap:anywhere]">
        {formatSize(props.size)}
        {props.origin ? ` from ${props.origin}` : ""}
        {props.fromAssistant ? ", started by the assistant" : ""}
      </p>
      {props.warning ? (
        <p role="alert" className="rounded bg-sunken px-2 py-1 text-fg">
          {props.warning}
        </p>
      ) : null}
      <p className="text-muted">Save in a folder on the computer that runs Ancilla:</p>
      <div className="flex items-center gap-1.5">
        <span title={folder} className="min-w-0 flex-1 truncate rounded bg-sunken px-2 py-1 text-fg">
          {folder}
        </span>
        <Button size="xs" variant="secondary" disabled={props.busy} onClick={() => setPicking((v) => !v)}>
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
      <p className="text-subtle">Nothing is saved until you press Save.</p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" variant="accent" disabled={props.busy} onClick={() => props.onSave(folder)}>
          Save
        </Button>
        <Button size="xs" variant="secondary" disabled={props.busy} onClick={props.onDont}>
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
export function DownloadBox(props: { download: { id: string; name: string; size: number | null; origin: string; page: string; folder: string; warning: string | null }; onAnswer(accept: boolean, folder?: string): void }) {
  const { download } = props;
  return (
    <div role="dialog" aria-modal="true" aria-label="Save this file" className="absolute inset-0 z-30 flex items-center justify-center bg-bg/60 p-4">
      <div className="max-h-full w-full max-w-sm overflow-y-auto rounded-lg border border-line bg-raised p-4 shadow-pop">
        <h2 className="mb-2 text-xs font-semibold text-muted">Save this file?</h2>
        <DownloadForm key={download.id} name={download.name} size={download.size} origin={download.origin} folder={download.folder} warning={download.warning} onSave={(folder) => props.onAnswer(true, folder)} onDont={() => props.onAnswer(false)} />
      </div>
    </div>
  );
}
