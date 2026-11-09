import { useRef, useState } from "react";
import { errorMessage } from "../../../../client.js";
import type { AvatarPackMeta, AvatarPackView } from "../../../../types.js";
import { Button, cn } from "../../../ui/primitives.js";
import { Avatar } from "../Avatar.js";
import { normalizeFigure, sameFigure } from "../figure/parts.js";
import { lookOfPack } from "../look.js";
import { usePack } from "../packs.js";
import type { Draft } from "./LookStudio.js";
import { avatarFileName, bytesLabel, copyOf, downloadText, parseAvatarFile, toAvatarFile, useAvatarLibrary, type Library } from "./library.js";

/**
 * Everything the user made or brought: wear one, change it, rename it, copy it, send it as a file, or delete it. The list
 * is the server's; a face on a card is the avatar itself, read through the same cache the sidebar's face uses.
 */

const KIND_LABEL: Record<AvatarPackMeta["kind"], string> = { figure: "Built", pixel: "Pixel art", image: "Picture" };

interface CardProps {
  meta: AvatarPackMeta;
  draft: Draft;
  lib: Library;
  onWear: (patch: Partial<Draft["avatar"]>) => void;
  onEdit: (to: "build" | "draw", id: string) => void;
  report: (note: { tone: "ok" | "error"; text: string } | null) => void;
}

function MineCard(props: CardProps) {
  const { meta, draft, lib } = props;
  const pack = usePack(meta.id, meta.updatedAt);
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [title, setTitle] = useState(meta.name);
  const [busy, setBusy] = useState(false);
  const look = draft.avatar.look;
  const wearing =
    pack !== undefined &&
    (pack.kind === "figure"
      ? look?.kind === "figure" && sameFigure(normalizeFigure(look.figure), normalizeFigure(pack.data.figure)) && draft.avatar.hue === pack.data.hue
      : look?.kind === "pack" && look.id === pack.id);

  const wear = (p: AvatarPackView) => {
    if (p.kind === "figure") props.onWear({ look: { kind: "figure", figure: normalizeFigure(p.data.figure) }, hue: p.data.hue, glow: p.data.glow });
    else props.onWear({ look: { kind: "pack", id: p.id, rev: p.updatedAt } });
  };
  const run = async (task: () => Promise<void>, ok?: string) => {
    setBusy(true);
    props.report(null);
    try {
      await task();
      if (ok) props.report({ tone: "ok", text: ok });
    } catch (e) {
      props.report({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const faceSpec = pack?.kind === "figure" ? { ...draft.avatar, hue: pack.data.hue, glow: pack.data.glow } : draft.avatar;
  return (
    <li className={cn("flex min-w-0 flex-col items-center gap-2 rounded-xl p-3 text-center", wearing ? "bg-accent-soft shadow-[0_0_0_1.5px_var(--accent)]" : "bg-sunken shadow-[0_0_0_1px_var(--border)]")}>
      {pack ? <Avatar spec={faceSpec} name={meta.name} render={lookOfPack(pack)} size={72} stage className="av-calm" /> : <span className="block size-[72px] animate-pulse rounded-full bg-hover" aria-hidden="true" />}
      {mode === "rename" ? (
        <form
          className="flex w-full flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await lib.update(meta.id, { name: title.trim() || meta.name }, meta.updatedAt);
              setMode("view");
            });
          }}
        >
          <input type="text" aria-label="New name" maxLength={40} value={title} onChange={(e) => setTitle(e.currentTarget.value)} className="h-7 w-full min-w-0 rounded-md bg-raised px-2 text-center text-sm text-fg shadow-[0_0_0_1px_var(--border)] outline-none focus-visible:ring-2 focus-visible:ring-focus" />
          <div className="flex justify-center gap-1.5">
            <Button size="xs" variant="accent" type="submit" loading={busy}>Save</Button>
            <Button size="xs" variant="ghost" onClick={() => setMode("view")}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="w-full min-w-0">
          <p className="truncate text-sm font-medium text-fg" title={meta.name}>{meta.name}</p>
          <p className="text-2xs text-subtle">{KIND_LABEL[meta.kind]} · {bytesLabel(meta.bytes)}</p>
        </div>
      )}
      {mode === "delete" ? (
        <div className="flex flex-col items-center gap-1.5">
          <p className="text-xs text-muted">Delete {meta.name}? This cannot be undone.</p>
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="danger"
              loading={busy}
              onClick={() =>
                void run(async () => {
                  // When this was the avatar being worn, the server has put the face back to a form of light as part of the delete, and the
                  // library has told the page to read the profile again: saving the same change a second time would be refused as out of date.
                  await lib.remove(meta.id);
                })
              }
            >
              Delete
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setMode("view")}>Keep</Button>
          </div>
        </div>
      ) : mode === "view" ? (
        <>
          <div className="flex flex-wrap justify-center gap-1.5">
            <Button size="xs" variant={wearing ? "secondary" : "accent"} disabled={!pack || wearing} onClick={() => pack && wear(pack)}>
              {wearing ? "Wearing" : "Wear"}
            </Button>
            {meta.kind !== "image" ? (
              <Button size="xs" variant="secondary" disabled={!pack} onClick={() => { if (pack) { if (pack.kind === "figure") wear(pack); props.onEdit(meta.kind === "figure" ? "build" : "draw", meta.id); } }}>
                Change
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap justify-center gap-x-2 gap-y-0.5 text-2xs">
            <button type="button" className="text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => { setTitle(meta.name); setMode("rename"); }}>Rename</button>
            <button
              type="button"
              disabled={!pack || busy}
              className="text-muted underline-offset-2 hover:text-fg hover:underline disabled:opacity-50"
              onClick={() => pack && void run(async () => { await lib.create(copyOf(pack, `${meta.name} copy`.slice(0, 40))); }, "Copied.")}
            >
              Copy
            </button>
            <button type="button" disabled={!pack} className="text-muted underline-offset-2 hover:text-fg hover:underline disabled:opacity-50" onClick={() => pack && downloadText(avatarFileName(pack.name), JSON.stringify(toAvatarFile(pack), null, 2))}>Export</button>
            <button type="button" className="text-danger-text underline-offset-2 hover:underline" onClick={() => setMode("delete")}>Delete</button>
          </div>
        </>
      ) : null}
    </li>
  );
}

export function MineTab(props: { draft: Draft; name: string; onWear: (patch: Partial<Draft["avatar"]>) => void; onEdit: (to: "build" | "draw", id: string) => void }) {
  const lib = useAvatarLibrary();
  const file = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const limits = lib.limits;

  const importFile = async (f: File) => {
    setBusy(true);
    setNote(null);
    try {
      const parsed = parseAvatarFile(await f.text());
      if (!parsed.ok) throw new Error(parsed.error);
      const saved = await lib.create(parsed.avatar);
      setNote({ tone: "ok", text: `Added ${saved.name}.` });
    } catch (e) {
      setNote({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 py-3">
        <div>
          <p className="text-sm font-medium text-fg">Everything you made or brought</p>
          <p className="mt-0.5 text-xs text-muted">{limits ? `${limits.total} of ${limits.count} avatars, ${bytesLabel(limits.used)} of ${bytesLabel(limits.totalBytes)} used.` : "They are kept with the rest of its data, on this computer."}</p>
        </div>
        <div>
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose an avatar file"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) void importFile(f);
            }}
          />
          <Button size="sm" variant="secondary" loading={busy} onClick={() => file.current?.click()}>
            Import an avatar file
          </Button>
        </div>
      </div>
      {note ? (
        <p role={note.tone === "error" ? "alert" : "status"} className={cn("mb-2 text-xs", note.tone === "error" ? "text-danger-text" : "text-muted")}>
          {note.text}
        </p>
      ) : null}
      {lib.error ? <p role="alert" className="mb-2 text-xs text-danger-text">{lib.error}</p> : null}
      {lib.avatars.length === 0 ? (
        <p className="rounded-xl bg-sunken p-4 text-sm text-muted shadow-[0_0_0_1px_var(--border)]">
          {lib.loading ? "Looking..." : "Nothing here yet. Build a figure, draw pixel art or bring a picture, and it will be kept here."}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 @min-[520px]:grid-cols-3 @min-[760px]:grid-cols-4">
          {lib.avatars.map((meta) => (
            <MineCard key={meta.id} meta={meta} draft={props.draft} lib={lib} onWear={props.onWear} onEdit={props.onEdit} report={setNote} />
          ))}
        </ul>
      )}
    </div>
  );
}
