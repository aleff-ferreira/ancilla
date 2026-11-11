import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";
import { errorMessage } from "../../../../client.js";
import type { AvatarMoodId, ImagePackData } from "../../../../types.js";
import { Button, cn } from "../../../ui/primitives.js";
import { Avatar } from "../Avatar.js";
import { Pills } from "../ui.js";
import { PictureError, encodePicture, loadPicture, pictureData, readPixels, release, type LoadedPicture } from "./bring-io.js";
import type { Draft } from "./LookStudio.js";
import { useAvatarLibrary } from "./library.js";
import { unpackPetArchive } from "./pet-zip.js";
import { MAX_GRID, MOOD_WORDS, SHEET_MOODS, compactSheet, hasArt, petRows, rowFrames, sequentialRows, sheetOf, suggestGrid, suggestGridFromPixels, type RowPlan } from "./raster.js";

/**
 * Bringing a picture in. One picture becomes a face that moves in its own way for each mood; a sprite sheet (a grid of
 * frames, one row for each mood that has its own) plays the frames it has and borrows motion for the rest. The picture is
 * shrunk to what a face needs and kept with the rest of the assistant's data, so nothing about it leaves this computer.
 */

type Mode = "picture" | "sheet";

const clampInt = (v: string, lo: number, hi: number, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

function NumberBox(props: { label: string; value: number; min: number; max: number; step?: number; onChange: (n: number) => void; className?: string }) {
  return (
    <label className={cn("flex items-center gap-1.5 text-xs text-muted", props.className)}>
      <span>{props.label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(clampInt(e.currentTarget.value, props.min, props.max, props.value))}
        className="h-7 w-16 rounded-md bg-raised px-2 text-sm text-fg shadow-[0_0_0_1px_var(--border)] outline-none focus-visible:ring-2 focus-visible:ring-focus"
      />
    </label>
  );
}

/** The sheet drawn small, with its grid on top, so the columns and rows can be checked by eye. */
function GridPreview(props: { picture: LoadedPicture; cols: number; rows: number }) {
  const { picture, cols, rows } = props;
  const lines: number[] = [];
  for (let c = 1; c < cols; c += 1) lines.push(c);
  const hlines: number[] = [];
  for (let r = 1; r < rows; r += 1) hlines.push(r);
  return (
    <div className="relative max-h-64 overflow-hidden rounded-lg bg-[conic-gradient(#8883_25%,transparent_0_50%,#8883_0_75%,transparent_0)] bg-[length:12px_12px] shadow-[0_0_0_1px_var(--border)]">
      <img src={picture.url} alt="The picture, with the grid it will be cut into" className="mx-auto block max-h-64 max-w-full [image-rendering:pixelated]" />
      <svg viewBox={`0 0 ${picture.w} ${picture.h}`} preserveAspectRatio="xMidYMid meet" className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
        {lines.map((c) => (
          <line key={`v${c}`} x1={(c * picture.w) / cols} x2={(c * picture.w) / cols} y1="0" y2={picture.h} stroke="var(--accent)" strokeOpacity="0.8" strokeWidth={Math.max(1, picture.w / 400)} />
        ))}
        {hlines.map((r) => (
          <line key={`h${r}`} y1={(r * picture.h) / rows} y2={(r * picture.h) / rows} x1="0" x2={picture.w} stroke="var(--accent)" strokeOpacity="0.8" strokeWidth={Math.max(1, picture.h / 400)} />
        ))}
      </svg>
    </div>
  );
}

export function BringTab(props: { draft: Draft; name: string; onWear: (patch: Partial<Draft["avatar"]>) => void; onDone: () => void }) {
  const { draft, name } = props;
  const lib = useAvatarLibrary();
  const input = useRef<HTMLInputElement>(null);
  const [picture, setPicture] = useState<LoadedPicture | null>(null);
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<Mode>("picture");
  const [cols, setCols] = useState(1);
  const [rows, setRows] = useState(1);
  const [isPetAtlas, setIsPetAtlas] = useState(false);
  const [plan, setPlan] = useState<RowPlan[]>([]);
  const [crisp, setCrisp] = useState(false);
  const [circle, setCircle] = useState(false);
  const [title, setTitle] = useState("");
  const [mood, setMood] = useState<AvatarMoodId>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const titleId = useId();

  // What is drawn in each cell of the sheet, read once per picture; the frame counts follow the grid.
  const pixels = useMemo(() => (picture && mode === "sheet" ? readPixels(picture) : null), [picture, mode]);
  // The grid the pixels suggest: the finest whose lines cross no drawing. A single picture has none.
  const guess = useMemo(() => (picture && pixels ? suggestGridFromPixels(pixels, picture.w, picture.h) : null), [picture, pixels]);
  const counts = useMemo(() => (pixels && picture ? rowFrames(pixels, picture.w, picture.h, cols, rows) : []), [pixels, picture, cols, rows]);

  useEffect(() => () => release(picture), [picture]);
  // A desktop-pet sheet starts on the desktop-pet mood map; any other new grid starts on the occupied rows in order.
  useEffect(() => {
    if (mode === "sheet" && counts.length === rows) setPlan(isPetAtlas ? petRows(counts) : sequentialRows(counts));
  }, [counts, mode, rows, isPetAtlas]);
  // Choosing "a sprite sheet" for a file that was not taken for one starts from the grid its pixels suggest, if they suggest one.
  useEffect(() => {
    if (mode === "sheet" && cols === 1 && rows === 1 && guess) {
      setCols(guess.cols);
      setRows(guess.rows);
      setIsPetAtlas(guess.atlas);
    }
  }, [mode, cols, rows, guess]);

  const open = async (file: File) => {
    setError(null);
    if (/\.json$/i.test(file.name)) {
      setError("That is an avatar file. Add it from Mine, with Import an avatar file.");
      return;
    }
    try {
      let targetFile = file;
      let forcedTitle = "";
      let fromPetZip = false;
      if (file.type === "application/zip" || file.type === "application/x-zip-compressed" || /\.zip$/i.test(file.name)) {
        const unpacked = await unpackPetArchive(new Uint8Array(await file.arrayBuffer()), file.name);
        targetFile = unpacked.file;
        forcedTitle = unpacked.title;
        fromPetZip = unpacked.desktopPet;
      }
      const loaded = await loadPicture(targetFile);
      setPicture(loaded);
      setFileName(file.name);
      setTitle(forcedTitle || file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim().slice(0, 40));
      setCrisp(Math.max(loaded.w, loaded.h) <= 128);
      setCircle(false);
      // A sheet with the cell size desktop pets share (or unpacked from a pet archive) opens straight in sheet mode.
      const g = suggestGrid(loaded.w, loaded.h);
      const petSheet = Boolean(g?.atlas) || Boolean(fromPetZip && g);
      setIsPetAtlas(petSheet);
      setMode(petSheet ? "sheet" : "picture");
      setCols(petSheet && g ? g.cols : 1);
      setRows(petSheet && g ? g.rows : 1);
      setMood("idle");
    } catch (e) {
      setError(e instanceof PictureError ? e.message : errorMessage(e));
    }
  };

  const reset = () => {
    setPicture(null);
    setFileName("");
    setIsPetAtlas(false);
    setPlan([]);
    setError(null);
    if (input.current) input.current.value = "";
  };

  const sheet = useMemo(() => (picture && mode === "sheet" && plan.length === rows ? sheetOf(cols, rows, plan) : undefined), [picture, mode, plan, cols, rows]);
  const preview: ImagePackData | null = picture ? { src: picture.url, w: picture.w, h: picture.h, ...(sheet ? { sheet } : {}), crisp } : null;

  const save = async () => {
    if (!picture) return;
    if (mode === "sheet" && !hasArt(plan)) {
      setError("Nothing is drawn in any row of this sheet. Check the number of columns and rows.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Encoding is the slow part (it draws every frame again at its stored size); the page stays still while it runs.
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      const compacted = mode === "sheet" && sheet ? compactSheet(sheet) : null;
      const encoded = encodePicture(picture, {
        cols: mode === "sheet" ? cols : 1,
        rows: mode === "sheet" ? rows : 1,
        ...(compacted ? { sourceRows: compacted.usedRows, keepCols: compacted.cols } : {}),
        maxCell: mode === "sheet" ? 192 : 320,
        crisp,
        circle: mode === "picture" && circle,
      });
      const pack = await lib.create({ name: title.trim() || "My picture", kind: "image", data: pictureData(encoded, compacted ? compacted.sheet : undefined, crisp) });
      props.onWear({ look: { kind: "pack", id: pack.id, rev: pack.updatedAt } });
      reset();
      props.onDone();
    } catch (e) {
      setError(e instanceof PictureError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) void open(f);
  };

  if (!picture || !preview) {
    return (
      <div>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
          className={cn("rounded-xl border border-dashed p-6 text-center transition-colors", over ? "border-accent bg-accent-soft" : "border-line-strong bg-sunken")}
        >
          <p className="text-sm font-medium text-fg">Bring a picture, sprite sheet, or desktop-pet package</p>
          <p className="mx-auto mt-1 max-w-prose text-xs text-muted text-pretty">
            Drop a desktop-pet <code className="font-mono text-fg">.zip</code> archive, an animated sprite sheet (<code className="font-mono text-fg">.webp</code> or <code className="font-mono text-fg">.png</code>), or any cut-out picture on a clear background. Everything stays on this computer.
          </p>
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,.zip,application/zip"
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose a picture, sprite sheet, or desktop-pet zip"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) void open(f);
            }}
          />
          <Button size="md" variant="accent" className="mt-3" onClick={() => input.current?.click()}>
            Choose a file
          </Button>
          <p className="mt-2 text-2xs text-subtle">or drop one here</p>
        </div>
        {error ? <p role="alert" className="mt-2 text-xs text-danger-text">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="@container">
      <div className="flex flex-col gap-4 @min-[640px]:flex-row">
        <div className="shrink-0 @min-[640px]:w-52">
          <div className="ch-stage compact flex justify-center rounded-xl p-3">
            <Avatar spec={draft.avatar} name={name} render={{ kind: "image", data: preview }} mood={mood} burst={Date.now()} size={132} look />
          </div>
          <div className="mt-2 flex flex-wrap justify-center gap-1" role="group" aria-label="Try a mood">
            {SHEET_MOODS.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mood === m}
                onClick={() => setMood(m)}
                className={cn("h-6 rounded-md px-2 text-2xs font-medium whitespace-nowrap transition-colors", mood === m ? "bg-accent-soft text-accent-text" : "bg-sunken text-subtle hover:bg-hover hover:text-fg")}
              >
                {MOOD_WORDS[m]}
              </button>
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-sm text-fg">
            <span className="font-medium">{fileName}</span> <span className="text-muted">{picture.w} by {picture.h} pixels</span>
          </p>
          <Pills<Mode> value={mode} onChange={setMode} label="What the file is" options={[{ value: "picture", label: "One picture" }, { value: "sheet", label: "A sprite sheet" }]} />
          {mode === "sheet" ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <NumberBox label="Columns" value={cols} min={1} max={MAX_GRID} onChange={setCols} />
                <NumberBox label="Rows" value={rows} min={1} max={MAX_GRID} onChange={setRows} />
                {guess && (guess.cols !== cols || guess.rows !== rows) ? (
                  <Button size="xs" variant="ghost" onClick={() => { setCols(guess.cols); setRows(guess.rows); }}>
                    Use {guess.cols} by {guess.rows}
                  </Button>
                ) : null}
              </div>
              <GridPreview picture={picture} cols={cols} rows={rows} />
              <div>
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium text-fg">Which row plays for which mood</p>
                  <div className="flex gap-1.5">
                    <Button size="xs" variant="ghost" onClick={() => setPlan(sequentialRows(counts))}>In order</Button>
                    <Button size="xs" variant="ghost" onClick={() => setPlan(petRows(counts))} title="A guess at the layout desktop-pet sheets share; check it against the preview">Desktop pet layout</Button>
                  </div>
                </div>
                <ul className="space-y-1.5">
                  {plan.map((p, r) => (
                    <li key={r} className="flex flex-wrap items-center gap-2 rounded-lg bg-sunken px-2.5 py-1.5 shadow-[0_0_0_1px_var(--border)]">
                      <span className="w-12 text-xs text-muted">Row {r + 1}</span>
                      {p.frames === 0 ? (
                        <span className="text-xs text-subtle">Nothing is drawn in this row.</span>
                      ) : (
                        <>
                          <select
                            aria-label={`Mood for row ${r + 1}`}
                            value={p.mood ?? ""}
                            onChange={(e) => {
                              const next = (e.currentTarget.value || null) as AvatarMoodId | null;
                              setPlan((all) => all.map((q, i) => (i === r ? { ...q, mood: next } : next && q.mood === next ? { ...q, mood: null } : q)));
                            }}
                            className="h-7 rounded-md bg-raised px-2 text-sm text-fg shadow-[0_0_0_1px_var(--border)] outline-none focus-visible:ring-2 focus-visible:ring-focus"
                          >
                            <option value="">Not used</option>
                            {SHEET_MOODS.map((m) => (
                              <option key={m} value={m}>{MOOD_WORDS[m]}</option>
                            ))}
                          </select>
                          <NumberBox label="Frames" value={p.frames} min={1} max={cols} onChange={(n) => setPlan((all) => all.map((q, i) => (i === r ? { ...q, frames: n } : q)))} />
                          <NumberBox label="ms" value={p.ms} min={40} max={2000} step={10} onChange={(n) => setPlan((all) => all.map((q, i) => (i === r ? { ...q, ms: n } : q)))} />
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-2xs text-subtle">A mood with no row wears the resting frames and moves in its own way.</p>
              </div>
            </div>
          ) : (
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={circle} onChange={(e) => setCircle(e.currentTarget.checked)} className="size-4 accent-[var(--accent)]" />
              Cut it to a circle
            </label>
          )}
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={crisp} onChange={(e) => setCrisp(e.currentTarget.checked)} className="size-4 accent-[var(--accent)]" />
            Pixel art: keep the edges sharp
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 @min-[420px]:max-w-64">
              <label htmlFor={titleId} className="mb-1 block text-xs text-muted">Name</label>
              <input id={titleId} type="text" maxLength={40} value={title} placeholder="My picture" onChange={(e) => setTitle(e.currentTarget.value)} className="h-8 w-full rounded-lg bg-sunken px-3 text-sm text-fg shadow-[0_0_0_1px_var(--border)] outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus" />
            </div>
            <Button size="md" variant="accent" loading={busy} onClick={() => void save()}>
              Save and wear
            </Button>
            <Button size="md" variant="ghost" disabled={busy} onClick={reset}>
              Choose another
            </Button>
          </div>
          {error ? <p role="alert" className="text-xs text-danger-text">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
