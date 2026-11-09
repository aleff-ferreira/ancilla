import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AvatarMoodId, PixelData } from "../../../../types.js";
import { Button, Toggle, cn } from "../../../ui/primitives.js";
import { Glyph } from "./glyphs.js";
import { decodeImageFile, download, fileStem, framePng, sheetPng, type DecodedImage } from "./image-io.js";
import {
  MAX_PALETTE,
  PALETTES,
  PIXEL_MOODS,
  PIXEL_MOOD_LABELS,
  PIXEL_SIZES,
  emptyFrame,
  fitInto,
  frameToRgba,
  quantize,
  resample,
} from "./pixel.js";
import { PixelSprite } from "./PixelSprite.js";
import { currentFrame, currentFrames, deleteReason, frameLimitReason, type EditorSnapshot } from "./tools.js";

/**
 * The studio's side panels: palette, frames, preview, size, import and export, and the screen a new drawing starts
 * on. Each is a plain view over the editor's snapshot with callbacks up; the studio keeps the history.
 */

export function Section(props: { title: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl bg-sunken p-3 shadow-[0_0_0_1px_var(--border)]", props.className)} aria-label={props.title}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-2xs font-medium tracking-wide text-subtle uppercase">{props.title}</h3>
        {props.hint ? <span className="truncate text-2xs text-subtle">{props.hint}</span> : null}
      </div>
      {props.children}
    </section>
  );
}

/** The small selectable button the panels share: a mood tab, a swatch's neighbour, a size. */
export const chipClass = (on: boolean, extra?: string): string =>
  cn("h-7 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus", on ? "bg-accent-soft text-accent-text shadow-[0_0_0_1.5px_var(--accent)]" : "bg-raised text-muted shadow-[0_0_0_1px_var(--border)] hover:bg-hover hover:text-fg", extra);

/**
 * A native `change` event, which a colour input fires once when its picker closes, where React's onChange fires on
 * every move. `mounted` says whether the input is in the tree, so one that appears later still gets its listener.
 */
function useNativeChange(ref: RefObject<HTMLInputElement | null>, handler: (value: string) => void, mounted = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const el = ref.current;
    if (!el || !mounted) return undefined;
    const onChange = () => latest.current(el.value);
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [ref, mounted]);
}

// ------------------------------------------------------------------------------------------------ thumbnails

/** A small crisp picture of RGBA bytes, drawn once the element exists. */
export function RgbaThumb(props: { rgba: Uint8ClampedArray; w: number; h: number; size: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const image = ctx.createImageData(props.w, props.h);
    image.data.set(props.rgba);
    ctx.putImageData(image, 0, 0);
  }, [props.rgba, props.w, props.h]);
  const scale = Math.min(props.size / props.w, props.size / props.h);
  return <canvas ref={ref} width={props.w} height={props.h} aria-hidden="true" className={props.className} style={{ width: Math.max(1, Math.round(props.w * scale)), height: Math.max(1, Math.round(props.h * scale)), imageRendering: "pixelated" }} />;
}

export const FrameThumb = (props: { palette: readonly string[]; frame: Uint8Array; w: number; h: number; size: number }) => (
  <RgbaThumb rgba={frameToRgba(props.palette, props.frame, props.w, props.h)} w={props.w} h={props.h} size={props.size} />
);

/** The checkerboard that stands for clear wherever a swatch is shown. */
const CLEAR_SWATCH = "repeating-conic-gradient(#8c8c8c 0 25%, #b8b8b8 0 50%) 0 0 / 8px 8px";

// ------------------------------------------------------------------------------------------------ start

export function StartScreen(props: { onStart: (size: number, paletteId: string) => void; onCancel: () => void }) {
  const [size, setSize] = useState(24);
  const [palette, setPalette] = useState("ancilla");
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-fg">Canvas size</p>
        <p className="mt-0.5 text-xs text-muted">Cells across and down. Small is quick to draw and reads well in the sidebar; it can be changed later.</p>
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Canvas size">
          {PIXEL_SIZES.map((s) => (
            <button key={s} type="button" aria-pressed={size === s} onClick={() => setSize(s)} className={chipClass(size === s, "h-8 px-3")}>
              {s} by {s}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="text-sm font-medium text-fg">Starter palette</p>
        <p className="mt-0.5 text-xs text-muted">Colours to begin with. You can add, change and remove them as you draw.</p>
        <div className="mt-2 grid grid-cols-1 gap-2 @min-[480px]:grid-cols-2 @min-[720px]:grid-cols-3" role="group" aria-label="Starter palette">
          {PALETTES.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={palette === p.id}
              onClick={() => setPalette(p.id)}
              className={cn("flex flex-col gap-2 rounded-xl p-3 text-left transition-[background-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-focus", palette === p.id ? "bg-accent-soft shadow-[0_0_0_1.5px_var(--accent)]" : "bg-sunken shadow-[0_0_0_1px_var(--border)] hover:bg-hover")}
            >
              <span className="flex items-baseline justify-between">
                <span className="text-sm font-medium text-fg">{p.name}</span>
                <span className="text-2xs text-subtle">{p.colours.length} colours</span>
              </span>
              <span className="flex h-4 overflow-hidden rounded" aria-hidden="true">
                {p.colours.map((c) => (
                  <span key={c} className="flex-1" style={{ background: c }} />
                ))}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="accent" onClick={() => props.onStart(size, palette)}>
          Start drawing
        </Button>
        <Button variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ palette

export interface PalettePanelProps {
  data: PixelData;
  /** The byte being painted: 0 is clear. */
  selected: number;
  onSelect: (byte: number) => void;
  onAdd: (hex: string) => void;
  /** `final` is the picker closing: one undo step for the whole drag. */
  onEdit: (index: number, hex: string, final: boolean) => void;
  onRemove: (index: number) => void;
  onLoad: (paletteId: string) => void;
}

export function PalettePanel(props: PalettePanelProps) {
  const { data, selected } = props;
  const addRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const [starter, setStarter] = useState("ancilla");
  const index = selected - 1;
  const current = index >= 0 ? data.palette[index] : undefined;
  useNativeChange(addRef, (value) => props.onAdd(value));
  useNativeChange(editRef, (value) => props.onEdit(index, value, true), current !== undefined);
  const full = data.palette.length >= MAX_PALETTE;
  return (
    <Section title="Palette" hint={`${data.palette.length} of ${MAX_PALETTE}`}>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Colours">
        <button
          type="button"
          aria-label="Clear"
          aria-pressed={selected === 0}
          onClick={() => props.onSelect(0)}
          className={cn("size-7 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus", selected === 0 ? "shadow-[0_0_0_2px_var(--bg-raised),0_0_0_3.5px_var(--fg)]" : "shadow-[0_0_0_1px_var(--border)]")}
          style={{ background: CLEAR_SWATCH }}
        />
        {data.palette.map((c, i) => (
          <button
            key={`${i}-${c}`}
            type="button"
            aria-label={`Colour ${i + 1}, ${c}`}
            aria-pressed={selected === i + 1}
            onClick={() => props.onSelect(i + 1)}
            className={cn("size-7 rounded-md outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-focus", selected === i + 1 ? "shadow-[0_0_0_2px_var(--bg-raised),0_0_0_3.5px_var(--fg)]" : "shadow-[0_0_0_1px_var(--border)]")}
            style={{ background: c }}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <span className="min-w-16 font-mono text-xs text-muted">{current ?? "Clear"}</span>
        {current ? (
          <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-raised px-2 text-xs font-medium text-fg shadow-btn hover:bg-hover">
            <input ref={editRef} type="color" aria-label={`Edit colour ${index + 1}`} value={current} onChange={(e) => props.onEdit(index, e.currentTarget.value, false)} className="size-4 cursor-pointer appearance-none rounded-sm border-0 bg-transparent p-0" />
            Edit
          </label>
        ) : null}
        {current ? (
          <Button size="xs" variant="ghost" onClick={() => props.onRemove(index)} aria-label={`Remove colour ${index + 1}`}>
            Remove
          </Button>
        ) : null}
        <label className={cn("inline-flex h-7 items-center gap-1 rounded-md bg-raised px-2 text-xs font-medium text-fg shadow-btn", full ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:bg-hover")}>
          <input ref={addRef} type="color" aria-label="Add colour" disabled={full} defaultValue="#000000" className="sr-only" />
          <Glyph name="plus" size={12} />
          Add
        </label>
      </div>
      {full ? <p className="mt-1.5 text-2xs text-subtle">The palette is full at {MAX_PALETTE} colours.</p> : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <select aria-label="Starter palette" value={starter} onChange={(e) => setStarter(e.currentTarget.value)} className="h-7 min-w-0 flex-1 rounded-md bg-raised px-2 text-xs text-fg shadow-[0_0_0_1px_var(--border)] outline-none focus-visible:ring-2 focus-visible:ring-focus">
          {PALETTES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.colours.length})
            </option>
          ))}
        </select>
        <Button size="xs" onClick={() => props.onLoad(starter)}>
          Load palette
        </Button>
      </div>
      <p className="mt-1.5 text-2xs text-subtle">Loading a palette keeps your drawing: each colour in use moves to the nearest new one.</p>
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ frames

export interface FramesPanelProps {
  snap: EditorSnapshot;
  playing: boolean;
  onPlaying: (on: boolean) => void;
  onion: boolean;
  onOnion: (on: boolean) => void;
  onMood: (mood: AvatarMoodId) => void;
  onFrame: (index: number) => void;
  onAdd: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  onCopyResting: () => void;
  onDropOwn: () => void;
  onMs: (ms: number) => void;
}

export function FramesPanel(props: FramesPanelProps) {
  const { snap } = props;
  const { data, mood } = snap;
  const shown = currentFrames(snap);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const msId = useId();
  const limit = frameLimitReason(snap);
  const noDelete = deleteReason(snap);
  useEffect(() => setConfirmDrop(false), [mood]);
  const n = shown.frames.length;
  return (
    <Section title="Frames" hint={`${n} frame${n === 1 ? "" : "s"}`}>
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Mood">
        {PIXEL_MOODS.map((m) => {
          const own = data.moods[m] !== undefined;
          return (
            <button key={m} type="button" role="tab" aria-selected={mood === m} aria-label={`${PIXEL_MOOD_LABELS[m]}${own ? ", has its own frames" : ""}`} onClick={() => props.onMood(m)} className={chipClass(mood === m, "h-6 px-1.5 text-2xs")}>
              {PIXEL_MOOD_LABELS[m]}
              {own ? <span aria-hidden="true" className="ml-1 inline-block size-1.5 rounded-full bg-current align-middle opacity-80" /> : null}
            </button>
          );
        })}
      </div>
      {!shown.own ? (
        <div className="mt-2 rounded-lg bg-raised p-2 text-xs text-muted shadow-[0_0_0_1px_var(--border)]">
          <p>
            <span className="font-medium text-fg">{PIXEL_MOOD_LABELS[mood]}</span> wears the resting frames and moves in its own way. Draw on it, or copy them here, to give it frames of its own.
          </p>
          <Button size="xs" className="mt-1.5" onClick={props.onCopyResting} disabled={limit !== null}>
            Copy the resting frames here
          </Button>
          {limit ? <p className="mt-1 text-2xs text-subtle">{limit}.</p> : null}
        </div>
      ) : null}
      <div className="mt-2 flex gap-1.5 overflow-x-auto py-1" role="group" aria-label="Frames of this mood">
        {shown.frames.map((frame, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Frame ${i + 1} of ${n}`}
            aria-pressed={snap.frame === i}
            onClick={() => props.onFrame(i)}
            className={cn("flex size-12 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus", snap.frame === i ? "shadow-[0_0_0_2px_var(--accent)]" : "shadow-[0_0_0_1px_var(--border)] hover:bg-hover", !shown.own && "opacity-60")}
            style={{ background: CLEAR_SWATCH }}
          >
            <FrameThumb palette={data.palette} frame={frame} w={data.w} h={data.h} size={44} />
          </button>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1" role="group" aria-label="Frame actions">
        <Button size="xs" variant="ghost" onClick={props.onAdd} disabled={limit !== null} aria-label="Add a blank frame">
          <Glyph name="plus" size={13} /> Add
        </Button>
        <Button size="xs" variant="ghost" onClick={props.onDuplicate} disabled={limit !== null} aria-label="Duplicate this frame">
          <Glyph name="copy" size={13} /> Duplicate
        </Button>
        <Button size="xs" variant="ghost" onClick={props.onDelete} disabled={noDelete !== null} aria-label="Delete this frame">
          <Glyph name="trash" size={13} /> Delete
        </Button>
        <Button size="xs" variant="ghost" onClick={() => props.onMove(-1)} disabled={!shown.own || snap.frame === 0} aria-label="Move this frame earlier">
          <Glyph name="left" size={13} /> Earlier
        </Button>
        <Button size="xs" variant="ghost" onClick={() => props.onMove(1)} disabled={!shown.own || snap.frame >= n - 1} aria-label="Move this frame later">
          Later <Glyph name="right" size={13} />
        </Button>
      </div>
      {limit ? <p className="mt-1 text-2xs text-subtle">{limit}.</p> : null}
      {shown.own && noDelete && snap.mood === "idle" ? <p className="mt-1 text-2xs text-subtle">{noDelete}.</p> : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button size="xs" onClick={() => props.onPlaying(!props.playing)} aria-pressed={props.playing} aria-label={props.playing ? "Pause the preview" : "Play the preview"}>
          <Glyph name={props.playing ? "pause" : "play"} size={12} /> {props.playing ? "Pause" : "Play"}
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <Toggle checked={props.onion} onChange={props.onOnion} label="Onion skin: show the previous frame faintly" />
          Onion skin
        </label>
      </div>
      <div className="mt-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={msId} className="text-xs text-fg">
            Frame time
          </label>
          <span className="text-xs text-muted">{shown.ms} ms</span>
        </div>
        <input id={msId} type="range" min={60} max={800} step={10} value={Math.max(60, Math.min(800, shown.ms))} disabled={!shown.own} onChange={(e) => props.onMs(Number(e.currentTarget.value))} className="companion-range mt-1" style={{ ["--v" as string]: `${((Math.max(60, Math.min(800, shown.ms)) - 60) / 740) * 100}%` }} />
        {!shown.own ? <p className="mt-1 text-2xs text-subtle">Timing follows the resting frames until this mood has its own.</p> : null}
      </div>
      {shown.own && mood !== "idle" ? (
        <div className="mt-2.5">
          {confirmDrop ? (
            <div className="rounded-lg bg-raised p-2 text-xs text-fg shadow-[0_0_0_1px_var(--border)]">
              <p>
                Drop the {n} frame{n === 1 ? "" : "s"} {PIXEL_MOOD_LABELS[mood]} has and wear the resting ones again? Undo brings them back.
              </p>
              <div className="mt-1.5 flex gap-1.5">
                <Button
                  size="xs"
                  variant="danger"
                  onClick={() => {
                    setConfirmDrop(false);
                    props.onDropOwn();
                  }}
                >
                  Drop them
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirmDrop(false)}>
                  Keep them
                </Button>
              </div>
            </div>
          ) : (
            <Button size="xs" variant="ghost" onClick={() => setConfirmDrop(true)}>
              Use the resting frames again
            </Button>
          )}
        </div>
      ) : null}
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ preview

export function PreviewPanel(props: { data: PixelData; playing: boolean; renderPreview?: ((data: PixelData, mood: AvatarMoodId) => ReactNode) | undefined }) {
  return (
    <Section title="In every mood">
      <div className="grid grid-cols-3 gap-2">
        {PIXEL_MOODS.map((mood) => (
          <figure key={mood} className="flex min-w-0 flex-col items-center gap-1">
            <div className="size-14">
              {props.renderPreview ? (
                props.renderPreview(props.data, mood)
              ) : (
                <svg viewBox="0 0 160 160" className="size-full" aria-hidden="true">
                  <circle cx="80" cy="80" r="78" fill="oklch(0.2 0.03 260)" />
                  <PixelSprite data={props.data} mood={mood} paused={!props.playing} />
                </svg>
              )}
            </div>
            <figcaption className="truncate text-2xs text-subtle">{PIXEL_MOOD_LABELS[mood]}</figcaption>
          </figure>
        ))}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ size

export function SizePanel(props: { data: PixelData; onResize: (size: number) => void }) {
  const [size, setSize] = useState(props.data.w);
  const same = size === props.data.w && size === props.data.h;
  return (
    <Section title="Canvas" hint={`${props.data.w} by ${props.data.h}`}>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="New size" value={size} onChange={(e) => setSize(Number(e.currentTarget.value))} className="h-7 rounded-md bg-raised px-2 text-xs text-fg shadow-[0_0_0_1px_var(--border)] outline-none focus-visible:ring-2 focus-visible:ring-focus">
          {PIXEL_SIZES.map((s) => (
            <option key={s} value={s}>
              {s} by {s}
            </option>
          ))}
        </select>
        <Button size="xs" onClick={() => props.onResize(size)} disabled={same}>
          Resize
        </Button>
      </div>
      <p className="mt-1.5 text-2xs text-subtle">Applies to every frame of every mood. The drawing keeps its place around the centre; what falls outside is cut off, new cells are clear.</p>
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ import

export interface ImportPanelProps {
  data: PixelData;
  /** The new frame, and the picture's own colours when the user chose to take them as the palette. */
  onPlace: (frame: Uint8Array, palette: string[] | null) => void;
  onError: (message: string) => void;
}

export function ImportPanel(props: ImportPanelProps) {
  const { data } = props;
  const [pending, setPending] = useState<DecodedImage | null>(null);
  const [colours, setColours] = useState(Math.min(16, Math.max(2, data.palette.length || 16)));
  const [fit, setFit] = useState(true);
  const [takeColours, setTakeColours] = useState(data.palette.length === 0);
  const [busy, setBusy] = useState(false);
  const fileId = useId();
  const coloursId = useId();

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      setPending(await decodeImageFile(file));
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "That file is not a picture we can read.");
    } finally {
      setBusy(false);
    }
  };

  const place = () => {
    if (!pending) return;
    if (!takeColours && data.palette.length === 0) {
      props.onError("Add a colour first, or take the picture's colours as the palette.");
      return;
    }
    const rect = fit ? fitInto(pending.w, pending.h, data.w, data.h) : { x: 0, y: 0, w: data.w, h: data.h };
    const small = resample(pending.rgba, pending.w, pending.h, rect.w, rect.h, "box");
    const q = quantize(small, rect.w, rect.h, takeColours ? { maxColours: colours } : { maxColours: colours, seedPalette: data.palette });
    const frame = emptyFrame(data.w, data.h);
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) frame[(rect.y + y) * data.w + rect.x + x] = q.frame[y * rect.w + x] ?? 0;
    props.onPlace(frame, takeColours ? q.palette : null);
    setPending(null);
  };

  return (
    <Section title="Import a picture">
      <label htmlFor={fileId} className={cn("inline-flex h-7 items-center gap-1.5 rounded-md bg-raised px-2.5 text-xs font-medium text-fg shadow-btn", busy ? "opacity-60" : "cursor-pointer hover:bg-hover")}>
        {busy ? "Reading..." : pending ? "Choose another" : "Choose a file"}
      </label>
      <input
        id={fileId}
        type="file"
        accept="image/*"
        disabled={busy}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          // Cleared so that choosing the same file again still counts as a choice.
          e.currentTarget.value = "";
          void choose(file);
        }}
        className="sr-only"
      />
      <p className="mt-1.5 text-2xs text-subtle">It becomes this frame, in as few colours as you choose. Undo puts the frame back.</p>
      {pending ? (
        <div className="mt-2.5 space-y-2.5 rounded-lg bg-raised p-2.5 shadow-[0_0_0_1px_var(--border)]">
          <div className="flex items-center gap-3">
            <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md" style={{ background: CLEAR_SWATCH }}>
              <RgbaThumb rgba={pending.rgba} w={pending.w} h={pending.h} size={56} />
            </div>
            <p className="text-xs text-muted">
              {pending.w} by {pending.h} pixels, going to {data.w} by {data.h} cells.
            </p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={coloursId} className="text-xs text-fg">
              Colours
            </label>
            <input id={coloursId} type="number" min={2} max={MAX_PALETTE} value={colours} onChange={(e) => setColours(Math.max(2, Math.min(MAX_PALETTE, Number(e.currentTarget.value) || 2)))} className="h-7 w-16 rounded-md bg-sunken px-2 text-xs text-fg shadow-[0_0_0_1px_var(--border)] outline-none focus-visible:ring-2 focus-visible:ring-focus" />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="How it fits">
            <button type="button" aria-pressed={fit} onClick={() => setFit(true)} className={chipClass(fit, "h-6 px-2 text-2xs")}>
              Keep its shape
            </button>
            <button type="button" aria-pressed={!fit} onClick={() => setFit(false)} className={chipClass(!fit, "h-6 px-2 text-2xs")}>
              Stretch to fill
            </button>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <Toggle checked={takeColours} onChange={setTakeColours} label="Take the picture's colours as the palette" />
            Take its colours as the palette
          </label>
          {takeColours ? <p className="text-2xs text-subtle">Other frames move to the nearest of the new colours.</p> : <p className="text-2xs text-subtle">Each pixel becomes the nearest colour you already have.</p>}
          <div className="flex gap-1.5">
            <Button size="xs" variant="accent" onClick={place}>
              Place it
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ export

export function ExportPanel(props: { snap: EditorSnapshot; name: string; onError: (message: string) => void }) {
  const [busy, setBusy] = useState<"frame" | "sheet" | null>(null);
  const run = async (which: "frame" | "sheet") => {
    setBusy(which);
    try {
      const { data } = props.snap;
      const blob = which === "frame" ? await framePng(data, currentFrame(props.snap), 8) : await sheetPng(data, 4);
      download(blob, `${fileStem(props.name)}${which === "frame" ? `-${props.snap.mood}-${props.snap.frame + 1}` : "-sheet"}.png`);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "The picture could not be made.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section title="Export">
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" loading={busy === "frame"} onClick={() => void run("frame")}>
          This frame as PNG
        </Button>
        <Button size="xs" loading={busy === "sheet"} onClick={() => void run("sheet")}>
          Sprite sheet
        </Button>
      </div>
      <p className="mt-1.5 text-2xs text-subtle">The frame at 8 times its size; the sheet has a row per mood and a column per frame, at 4 times.</p>
    </Section>
  );
}
