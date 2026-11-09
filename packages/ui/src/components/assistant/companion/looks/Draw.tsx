import { useState } from "react";
import { errorMessage } from "../../../../client.js";
import type { AvatarPackView, PixelData } from "../../../../types.js";
import { Button } from "../../../ui/primitives.js";
import { Avatar } from "../Avatar.js";
import { usePack } from "../packs.js";
import { describePixel } from "../pixel/pixel.js";
import { PixelStudio } from "../pixel/PixelStudio.js";
import type { Draft } from "./LookStudio.js";
import { useAvatarLibrary } from "./library.js";

/**
 * Pixel art for the assistant's face: the studio, and what happens around it. A drawing is kept in the library as soon as
 * it is saved and worn at once; opening one from Mine edits it in place, and saving writes the same avatar again.
 */

export interface DrawProps {
  draft: Draft;
  name: string;
  /** The pixel art in the library to keep drawing, when the user came from Mine. */
  edit: AvatarPackView | null;
  onWear: (patch: Partial<Draft["avatar"]>) => void;
  onDone: () => void;
}

export function DrawTab(props: DrawProps) {
  const { draft, name, edit } = props;
  const lib = useAvatarLibrary();
  const worn = draft.avatar.look?.kind === "pack" ? draft.avatar.look : null;
  const wornPack = usePack(worn?.id ?? null, worn?.rev ?? 0);
  const [open, setOpen] = useState(edit?.kind === "pixel");
  const [target, setTarget] = useState<AvatarPackView | null>(edit?.kind === "pixel" ? edit : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wornPixel = wornPack?.kind === "pixel" ? wornPack : null;

  const save = async (title: string, data: PixelData) => {
    setBusy(true);
    setError(null);
    try {
      const pack = target && target.kind === "pixel" ? await lib.update(target.id, { name: title, data }, target.updatedAt) : await lib.create({ name: title, kind: "pixel", data });
      props.onWear({ look: { kind: "pack", id: pack.id, rev: pack.updatedAt } });
      setOpen(false);
      setTarget(null);
      props.onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    return (
      <PixelStudio
        key={target?.id ?? "new"}
        {...(target && target.kind === "pixel" ? { initial: target.data, name: target.name } : {})}
        onSave={save}
        onCancel={() => {
          setOpen(false);
          setTarget(null);
          setError(null);
        }}
        saving={busy}
        error={error}
        renderPreview={(data, mood) => <Avatar spec={draft.avatar} name={name} render={{ kind: "pixel", data }} mood={mood} size={56} stage />}
      />
    );
  }

  return (
    <div className="rounded-xl bg-sunken p-4 shadow-[0_0_0_1px_var(--border)]">
      <p className="text-sm font-medium text-fg">Draw it in pixels</p>
      <p className="mt-1 text-xs text-muted text-pretty">
        Paint a small picture cell by cell, with the tools you would expect: a pencil, a fill, mirroring, undo. Give each mood its own frames, or leave a mood out and it wears the resting picture and moves in its own way. You can start from a picture too.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="accent"
          onClick={() => {
            setTarget(null);
            setOpen(true);
          }}
        >
          New drawing
        </Button>
        {wornPixel ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setTarget(wornPixel);
              setOpen(true);
            }}
          >
            Keep drawing {wornPixel.name}
          </Button>
        ) : null}
      </div>
      {wornPixel ? <p className="mt-2 text-xs text-subtle">{describePixel(wornPixel.data)}.</p> : null}
      {lib.error ? <p className="mt-2 text-xs text-danger-text">{lib.error}</p> : null}
    </div>
  );
}
