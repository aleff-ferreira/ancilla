import { useEffect, useState, type ChangeEvent, type JSX } from "react";
import { FileTextIcon, PaperclipIcon, XIcon } from "../ui/icons.js";
import type { AttachmentView, OutgoingAttachment } from "../../types.js";
import type { EchoAttachment } from "../../model/fold.js";
import { cn } from "../ui/primitives.js";

export interface PendingFile { id: string; name: string; mediaType: string; kind: "image" | "file"; url: string | null; base64: string; width?: number; height?: number; size: number; }

export function kindOf(mediaType: string): "image" | "file" {
  return /^image\//i.test(mediaType) ? "image" : "file";
}

function encodeUint8ToBase64(bytes: Uint8Array): string {
  const CHUNK_LEN = 0x8000;
  let binaryAcc = "";
  for (let idx = 0; idx < bytes.length; idx += CHUNK_LEN) {
    binaryAcc += String.fromCharCode(...bytes.subarray(idx, idx + CHUNK_LEN));
  }
  return btoa(binaryAcc);
}

async function probeImageDimensions(objectUrl: string): Promise<{ width: number; height: number } | null> {
  try {
    const imgElement = new Image();
    imgElement.src = objectUrl;
    await imgElement.decode();
    return imgElement.naturalWidth > 0 ? { width: imgElement.naturalWidth, height: imgElement.naturalHeight } : null;
  } catch {
    return null;
  }
}

let monotonicAttachmentSeq = 0;
function nextAttachmentId(): string {
  monotonicAttachmentSeq += 1;
  return `file-${Date.now().toString(36)}-${monotonicAttachmentSeq}`;
}

export const readFiles = async (files: Iterable<File>): Promise<PendingFile[]> => {
  const fileItems = Array.from(files);
  return Promise.all(
    fileItems.map(async (f) => {
      const mime = f.type || "application/octet-stream";
      const isGraphic = mime.startsWith("image/");
      const byteData = new Uint8Array(await f.arrayBuffer());
      const localUrl = isGraphic ? URL.createObjectURL(f) : null;
      const geometry = localUrl ? await probeImageDimensions(localUrl) : null;

      return {
        id: nextAttachmentId(),
        name: f.name || (isGraphic ? "pasted-image.png" : "file"),
        mediaType: mime,
        kind: isGraphic ? "image" : "file",
        url: localUrl,
        base64: encodeUint8ToBase64(byteData),
        ...(geometry ?? {}),
        size: byteData.byteLength,
      };
    }),
  );
};

export const refetchAttachments = async (files: readonly AttachmentView[]): Promise<PendingFile[]> => {
  return Promise.all(
    files.map(async (f) => {
      const res = await fetch(f.url);
      if (!res.ok) {
        throw new Error(`Failed to retrieve attachment ${f.name} (${res.status})`);
      }
      const rawBytes = new Uint8Array(await res.arrayBuffer());
      return {
        id: nextAttachmentId(),
        name: f.name,
        mediaType: f.mediaType,
        kind: f.kind,
        url: f.kind === "image" ? f.url : null,
        base64: encodeUint8ToBase64(rawBytes),
        ...(f.width !== null && f.height !== null ? { width: f.width, height: f.height } : {}),
        size: rawBytes.byteLength,
      };
    }),
  );
};

export function toOutgoing(file: PendingFile): OutgoingAttachment {
  const payload: OutgoingAttachment = { name: file.name, mediaType: file.mediaType, base64: file.base64 };
  if (file.width !== undefined && file.height !== undefined) {
    payload.width = file.width;
    payload.height = file.height;
  }
  return payload;
}

export function restoreFiles(attachments: readonly OutgoingAttachment[], previews: readonly EchoAttachment[]): PendingFile[] {
  return attachments.map((outgoing, index) => {
    const preview = previews[index];
    const padCount = outgoing.base64.endsWith("==") ? 2 : outgoing.base64.endsWith("=") ? 1 : 0;
    const computedBytes = Math.max(0, Math.floor((outgoing.base64.length * 3) / 4) - padCount);

    return {
      id: nextAttachmentId(),
      name: outgoing.name,
      mediaType: outgoing.mediaType,
      kind: preview?.kind ?? kindOf(outgoing.mediaType),
      url: preview?.url ?? null,
      base64: outgoing.base64,
      ...(outgoing.width !== undefined && outgoing.height !== undefined ? { width: outgoing.width, height: outgoing.height } : {}),
      size: computedBytes,
    };
  });
}

export function toPreview(file: PendingFile): EchoAttachment {
  const { name, mediaType, kind, url } = file;
  return { name, mediaType, kind, url };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

function Lightbox({ name, url, onClose }: { name: string; url: string; onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div role="dialog" aria-modal="true" aria-label={name} onClick={onClose} className="overlay-fade fixed inset-0 z-50 flex items-center justify-center bg-[oklch(0_0_0/0.62)] p-8">
      <img src={url} alt={name} className="modal-pop max-h-full max-w-full rounded-xl object-contain shadow-pop" />
    </div>
  );
}

function StagedImageThumbnail({ file, onOpen }: { file: PendingFile; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} aria-label={`Open ${file.name}`} className="block size-16 overflow-hidden rounded-xl bg-sunken shadow-[0_0_0_1px_var(--border)] transition-transform duration-150 ease-out active:scale-[0.97]">
      <img src={file.url ?? ""} alt={file.name} className="size-full object-cover" />
    </button>
  );
}

function StagedFileDocCard({ file }: { file: PendingFile }) {
  const sizeLabel = formatSize(file.size);
  return (
    <div className="flex h-16 max-w-[220px] items-center gap-2.5 rounded-xl bg-sunken px-3 shadow-[0_0_0_1px_var(--border)]">
      <FileTextIcon size={15} className="text-subtle shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-fg">{file.name}</span>
        <span className="block text-2xs text-subtle">{sizeLabel}</span>
      </div>
    </div>
  );
}

function renderStagedCard(file: PendingFile, onOpen: () => void) {
  if (file.kind === "image" && file.url) {
    return <StagedImageThumbnail file={file} onOpen={onOpen} />;
  }
  return <StagedFileDocCard file={file} />;
}

function RemoveStagedBadge({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <button type="button" aria-label={`Remove ${name}`} onClick={onRemove} className="absolute -top-1.5 -right-1.5 inline-flex size-5 items-center justify-center rounded-full bg-inverse text-inverse-fg opacity-0 shadow-pop transition-opacity duration-100 group-hover/att:opacity-100 focus-visible:opacity-100">
      <XIcon size={11} className="shrink-0" />
    </button>
  );
}

export interface AttachmentTrayProps { files: PendingFile[]; onRemove: (id: string) => void; }

export function AttachmentTray({ files, onRemove }: AttachmentTrayProps): JSX.Element | null {
  const [activePreview, setActivePreview] = useState<PendingFile | null>(null);

  if (files.length === 0) return null;

  return (
    <>
      <ul className="flex flex-wrap items-center gap-2 px-3 pt-3">
        {files.map((file) => (
          <li key={file.id} className="group/att relative shrink-0">
            {renderStagedCard(file, () => setActivePreview(file))}
            <RemoveStagedBadge name={file.name} onRemove={() => onRemove(file.id)} />
          </li>
        ))}
      </ul>
      {activePreview?.url && (
        <Lightbox name={activePreview.name} url={activePreview.url} onClose={() => setActivePreview(null)} />
      )}
    </>
  );
}

function SentImageThumbnail({ name, url, onOpen }: { name: string; url: string; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} aria-label={`Open ${name}`} className="block max-h-44 overflow-hidden rounded-xl bg-sunken shadow-[0_0_0_1px_var(--border)] transition-transform duration-150 ease-out active:scale-[0.98]">
      <img src={url} alt={name} className="max-h-44 w-auto object-contain" />
    </button>
  );
}

function SentFileBadge({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-lg bg-sunken px-2.5 py-1.5 text-xs text-muted shadow-[0_0_0_1px_var(--border)]">
      <FileTextIcon size={13} className="text-subtle shrink-0" />
      {name}
    </span>
  );
}

function renderSentCard(file: AttachmentView | EchoAttachment, onZoom: (url: string) => void) {
  if (file.kind === "image" && file.url) {
    return <SentImageThumbnail name={file.name} url={file.url as string} onOpen={() => onZoom(file.url as string)} />;
  }
  return <SentFileBadge name={file.name} />;
}

export interface SentAttachmentsProps { files: (AttachmentView | EchoAttachment)[]; className?: string; }

export function SentAttachments({ files, className }: SentAttachmentsProps): JSX.Element | null {
  const [zoomTarget, setZoomTarget] = useState<{ name: string; url: string } | null>(null);

  if (files.length === 0) return null;

  return (
    <>
      <ul className={cn("flex flex-wrap justify-end gap-2", className)}>
        {files.map((file, idx) => {
          const itemKey = "id" in file ? file.id : `${file.name}-${idx}`;
          return (
            <li key={itemKey} className="shrink-0">
              {renderSentCard(file, (url) => setZoomTarget({ name: file.name, url }))}
            </li>
          );
        })}
      </ul>
      {zoomTarget && (
        <Lightbox name={zoomTarget.name} url={zoomTarget.url} onClose={() => setZoomTarget(null)} />
      )}
    </>
  );
}

export interface AttachButtonProps { onFiles: (files: FileList) => void; disabled?: boolean; }

export function AttachButton({ onFiles, disabled }: AttachButtonProps): JSX.Element {
  const triggerStyle = cn("inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors duration-100 hover:bg-hover hover:text-fg", disabled && "pointer-events-none opacity-50");

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = e.currentTarget.files;
    if (chosen?.length) onFiles(chosen);
    e.currentTarget.value = "";
  };

  return (
    <label className={triggerStyle}>
      <span className="sr-only">Select files to attach</span>
      <PaperclipIcon size={14} className="shrink-0" />
      <input type="file" multiple disabled={disabled} onChange={handleFileChange} className="hidden" />
    </label>
  );
}
