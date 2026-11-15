import { useState } from "react";
import { errorMessage } from "../../../../client.js";
import type { AvatarPackView } from "../../../../types.js";
import { Button } from "../../../ui/primitives.js";
import { normalizeFigure } from "../figure/parts.js";
import type { Draft } from "./LookStudio.js";
import { useAvatarLibrary } from "./library.js";

/**
 * Keeps the figure being built in the library, under a name, so it can be worn again, changed or shared later. When the
 * figure came from the library (Mine, Change), the changes can be saved back into it, or kept as a new avatar beside it.
 */
export function SaveFigure({ draft, editing }: { draft: Draft; editing?: AvatarPackView | null }) {
  const lib = useAvatarLibrary();
  const [name, setName] = useState(editing?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const look = draft.avatar.look;
  if (look?.kind !== "figure") return null;
  const data = { figure: normalizeFigure(look.figure), hue: draft.avatar.hue, glow: draft.avatar.glow };

  const run = async (task: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ tone: "ok", text: await task() });
    } catch (e) {
      setNote({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const saveNew = () =>
    run(async () => {
      const saved = await lib.create({ name: name.trim() || "My figure", kind: "figure", data });
      if (!editing) setName("");
      return `Kept as ${saved.name}. It is under Mine.`;
    });
  const saveChanges = () =>
    run(async () => {
      if (!editing) return "";
      const saved = await lib.update(editing.id, { name: name.trim() || editing.name, data }, editing.updatedAt);
      return `Saved the changes to ${saved.name}.`;
    });

  return (
    <div className="mt-4 rounded-xl bg-sunken p-3 shadow-[0_0_0_1px_var(--border)]">
      <p className="text-sm font-medium text-fg">{editing ? `You are changing ${editing.name}` : "Keep this one"}</p>
      <p className="mt-0.5 text-xs text-muted">
        {editing ? "Save the changes into it, or keep this as a new avatar beside it." : "Save it under a name to find it again, change it later, or send it to someone as a file."}
      </p>
      <form
        className="mt-2 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void (editing ? saveChanges() : saveNew());
        }}
      >
        <input
          type="text"
          aria-label="Name for this avatar"
          maxLength={40}
          value={name}
          placeholder="My figure"
          onChange={(e) => setName(e.currentTarget.value)}
          className="h-8 min-w-0 flex-1 rounded-lg bg-raised px-3 text-sm text-fg shadow-[0_0_0_1px_var(--border)] outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus @min-[420px]:max-w-64"
        />
        {editing ? (
          <>
            <Button size="md" variant="accent" type="submit" loading={busy}>
              Save changes
            </Button>
            <Button size="md" variant="secondary" disabled={busy} onClick={() => void saveNew()}>
              Save as new
            </Button>
          </>
        ) : (
          <Button size="md" variant="secondary" type="submit" loading={busy}>
            Save to my avatars
          </Button>
        )}
      </form>
      {note ? (
        <p role={note.tone === "error" ? "alert" : "status"} className={note.tone === "error" ? "mt-2 text-xs text-danger-text" : "mt-2 text-xs text-muted"}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}
