import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AvatarMoodId, PixelData } from "../../../../types.js";
import { Tip } from "../../../ui/overlays.js";
import { Button, Toggle, cn } from "../../../ui/primitives.js";
import { Glyph, type GlyphName } from "./glyphs.js";
import { ExportPanel, FramesPanel, ImportPanel, PalettePanel, PreviewPanel, SizePanel, StartScreen } from "./panels.js";
import { PixelCanvas, type PixelCanvasHandle, type PointerPhase } from "./PixelCanvas.js";
import {
  PIXEL_MOOD_LABELS,
  addColour,
  blankPixelData,
  changedCells,
  clearFrame,
  flipH,
  flipV,
  paletteById,
  removeColour,
  replacePalette,
  resizePixelData,
  rotate90,
  setColour,
  shiftFrame,
  validatePixelData,
  type MirrorMode,
  type Point,
} from "./pixel.js";
import {
  MIRRORS,
  TOOLS,
  addFrame,
  canvasLabel,
  continueStroke,
  copyRestingHere,
  currentFrame,
  currentFrames,
  deleteFrame,
  dropOwnFrames,
  idleIsEmpty,
  moveFrame,
  nextMirror,
  pushHistory,
  setFrame,
  setMs,
  shapeFrame,
  startStroke,
  strokeWord,
  toolForKey,
  toolInfo,
  type EditorSnapshot,
  type History,
  type StrokeState,
  type Tool,
} from "./tools.js";

/**
 * The pixel studio: a canvas, tools, a palette, frames for each mood and a preview, in one panel that measures itself
 * (it sits inside the Persona page, whose columns come and go). Strokes are drawn on the canvas as they happen and
 * become one undo step when the pointer comes up; everything that changes the data goes through `commit`, so undo and
 * the status line stay true whichever control made the change.
 */

export interface PixelStudioProps {
  initial?: PixelData;
  name?: string;
  onSave: (name: string, data: PixelData) => void | Promise<void>;
  onCancel: () => void;
  saving?: boolean;
  error?: string | null;
  /** The avatar as the app draws it, for the preview; without it a plain sprite on the stage disc is shown. */
  renderPreview?: (data: PixelData, mood: AvatarMoodId) => ReactNode;
}

const DEFAULT_NAME = "My pixel avatar";
const MAX_NAME = 40;
const MIN_ZOOM = 2;
const MAX_ZOOM = 48;

const reducedMotion = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const isTyping = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return !!el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable);
};

export function PixelStudio(props: PixelStudioProps) {
  const [snap, setSnap] = useState<EditorSnapshot | null>(() => (props.initial ? { data: props.initial, mood: "idle", frame: 0 } : null));
  const [history, setHistory] = useState<History>({ past: [], future: [] });
  const [tool, setTool] = useState<Tool>("pencil");
  const [colour, setColourByte] = useState<number>(() => (props.initial?.palette.length ? 1 : 0));
  const [mirror, setMirror] = useState<MirrorMode>("none");
  const [filled, setFilled] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [grid, setGrid] = useState(true);
  const [onion, setOnion] = useState(false);
  const [playing, setPlaying] = useState(() => !reducedMotion());
  const [zoomAdjust, setZoomAdjust] = useState(0);
  const [boxWidth, setBoxWidth] = useState(320);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [anchor, setAnchor] = useState<Point | null>(null);
  const [status, setStatus] = useState("");
  const [name, setName] = useState(props.name ?? DEFAULT_NAME);
  const [localError, setLocalError] = useState<string | null>(null);
  // Cancel asks first when there is something to lose: a change that was made and not saved.
  const [confirmCancel, setConfirmCancel] = useState(false);
  const canvas = useRef<PixelCanvasHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const stroke = useRef<StrokeState | null>(null);
  const colourEditBase = useRef<EditorSnapshot | null>(null);
  const statusId = useId();
  const nameId = useId();

  // The canvas fills the width it is given, in whole pixels per cell, and the +/- buttons nudge from there.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => setBoxWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [snap === null]);

  const zoom = useMemo(() => {
    if (!snap) return MIN_ZOOM;
    const fit = Math.floor(Math.min(Math.max(120, boxWidth - 4), 560) / Math.max(snap.data.w, snap.data.h));
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fit + zoomAdjust));
  }, [snap, boxWidth, zoomAdjust]);

  // The frame in view is unpacked once per snapshot, so the canvas repaints when the data changes and not on every render.
  const view = useMemo(() => (snap ? { shown: currentFrames(snap), frame: currentFrame(snap) } : null), [snap]);

  if (!snap || !view) {
    return (
      <div className="pixel-studio @container">
        <StartScreen
          onStart={(size, paletteId) => {
            setSnap({ data: blankPixelData(size, paletteId), mood: "idle", frame: 0 });
            setColourByte(paletteById(paletteId).colours.length ? 1 : 0);
            setStatus(`A blank ${size} by ${size} canvas`);
          }}
          onCancel={props.onCancel}
        />
      </div>
    );
  }

  const { data } = snap;
  const { shown, frame } = view;
  const previous = snap.frame > 0 ? (shown.frames[snap.frame - 1] ?? null) : null;

  /** Every change to the data lands here: the step before it is kept for undo and the status line says what happened. */
  const commit = (next: EditorSnapshot, word: string) => {
    setHistory((h) => pushHistory(h, snap));
    setSnap(next);
    setStatus(word);
    setLocalError(null);
  };

  const undo = () => {
    const before = history.past[history.past.length - 1];
    if (!before) return;
    setHistory({ past: history.past.slice(0, -1), future: [snap, ...history.future] });
    setSnap(before);
    setStatus("Undid");
  };

  const redo = () => {
    const next = history.future[0];
    if (!next) return;
    setHistory({ past: [...history.past, snap], future: history.future.slice(1) });
    setSnap(next);
    setStatus("Redid");
  };

  /** A finished frame for the one in view, as one step. A mood that wore the resting frames gets its own and the status says so. */
  const commitFrame = (next: Uint8Array, word: string) => {
    const changed = changedCells(frame, next);
    if (changed === 0) {
      setStatus("Nothing changed");
      return;
    }
    const gained = !shown.own && snap.mood !== "idle" ? `. ${PIXEL_MOOD_LABELS[snap.mood]} now has its own frames` : "";
    commit(setFrame(snap, snap.frame, next), `${word}${gained}`);
  };

  const pick = (cell: Point) => {
    const byte = frame[cell[1] * data.w + cell[0]] ?? 0;
    setColourByte(byte);
    setStatus(byte ? `Picked colour ${byte}, ${data.palette[byte - 1] ?? ""}` : "Picked clear");
  };

  const onPointer = (phase: PointerPhase, cell: Point, mods: { shift: boolean; button: number }) => {
    if (phase === "down") {
      setAnchor(null);
      if (tool === "picker") {
        pick(cell);
        return;
      }
      stroke.current = startStroke({ tool, w: data.w, h: data.h, colour: mods.button === 2 ? 0 : colour, mirror, filled: filled || mods.shift, wrap, base: frame, at: cell });
      canvas.current?.preview(stroke.current.work);
      return;
    }
    const current = stroke.current;
    if (!current) return;
    if (phase === "move") {
      stroke.current = continueStroke(current, cell);
      canvas.current?.preview(stroke.current.work);
      return;
    }
    stroke.current = null;
    const done = continueStroke(current, cell).work;
    canvas.current?.preview(null);
    commitFrame(done, strokeWord(current.tool, changedCells(current.base, done), current.colour === 0));
  };

  /** The keyboard's way to paint: the current tool at the cursor cell. Shapes take two presses, one for each corner. */
  const applyAt = (cell: Point) => {
    if (tool === "picker") return pick(cell);
    if (tool === "move") return setStatus("Use the arrow buttons under the canvas to move the frame");
    if (tool === "line" || tool === "rect" || tool === "ellipse") {
      if (!anchor) {
        setAnchor(cell);
        setStatus("First corner set. Move the cursor and press Space for the other.");
        return;
      }
      setAnchor(null);
      const shaped = shapeFrame(tool, frame, data.w, data.h, anchor, cell, colour, filled, mirror);
      return commitFrame(shaped, strokeWord(tool, changedCells(frame, shaped), colour === 0));
    }
    const result = startStroke({ tool, w: data.w, h: data.h, colour, mirror, filled, wrap, base: frame, at: cell }).work;
    commitFrame(result, strokeWord(tool, changedCells(frame, result), colour === 0));
  };

  const onCanvasKey = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const step = event.shiftKey ? 4 : 1;
    const at: Point = cursor ?? [Math.floor(data.w / 2), Math.floor(data.h / 2)];
    const move = (dx: number, dy: number) => setCursor([Math.max(0, Math.min(data.w - 1, at[0] + dx)), Math.max(0, Math.min(data.h - 1, at[1] + dy))]);
    switch (event.key) {
      case "ArrowLeft":
        move(-step, 0);
        break;
      case "ArrowRight":
        move(step, 0);
        break;
      case "ArrowUp":
        move(0, -step);
        break;
      case "ArrowDown":
        move(0, step);
        break;
      case " ":
      case "Enter":
        if (!cursor) setCursor(at);
        applyAt(at);
        break;
      case "Escape":
        setAnchor(null);
        setStatus("Corner cleared");
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onRootKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTyping(event.target)) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (mod && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && key === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (mod || event.altKey) return;
    const picked = toolForKey(event.key);
    if (picked) {
      setTool(picked);
      setStatus(`${toolInfo(picked).name} tool`);
      event.preventDefault();
      return;
    }
    if (key === "m") {
      const next = nextMirror(mirror);
      setMirror(next);
      setStatus(MIRRORS.find((m) => m.id === next)?.name ?? "");
      event.preventDefault();
    } else if (key === "[" || key === "]") {
      const to = snap.frame + (key === "[" ? -1 : 1);
      if (to >= 0 && to < shown.frames.length) setSnap({ ...snap, frame: to });
      event.preventDefault();
    } else if (key === "+" || key === "=" || key === "-") {
      setZoomAdjust((z) => z + (key === "-" ? -2 : 2));
      event.preventDefault();
    }
  };

  const transform = (fn: (f: Uint8Array) => Uint8Array, word: string) => commitFrame(fn(frame), word);

  const editColour = (index: number, hex: string, final: boolean) => {
    const base = colourEditBase.current ?? snap;
    const next = { ...snap, data: setColour(snap.data, index, hex) };
    if (!final) {
      colourEditBase.current = base;
      setSnap(next);
      return;
    }
    colourEditBase.current = null;
    setHistory((h) => pushHistory(h, base));
    setSnap(next);
    setStatus(`Colour ${index + 1} is now ${hex}`);
  };

  const save = async () => {
    const check = validatePixelData(data);
    if (!check.ok) {
      setLocalError(check.error);
      return;
    }
    setLocalError(null);
    await props.onSave(name.trim().slice(0, MAX_NAME) || DEFAULT_NAME, check.data);
  };

  const empty = idleIsEmpty(data);
  const saveReason = props.saving ? "Saving" : empty ? "Draw something first" : null;
  const error = props.error ?? localError;
  const toolbarButton = (on: boolean) => cn("inline-flex size-8 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus", on ? "bg-accent-soft text-accent-text shadow-[0_0_0_1.5px_var(--accent)]" : "text-muted hover:bg-hover hover:text-fg");
  const smallButton = (label: string, glyph: GlyphName, onClick: () => void, disabled = false) => (
    <Tip label={label}>
      <button type="button" aria-label={label} onClick={onClick} disabled={disabled} className="inline-flex size-7 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-40">
        <Glyph name={glyph} size={14} />
      </button>
    </Tip>
  );

  return (
    <div className="pixel-studio @container" onKeyDown={onRootKey}>
      <div className="flex flex-col gap-3 @min-[720px]:flex-row @min-[720px]:items-start">
        <div role="toolbar" aria-label="Tools" className="flex flex-wrap gap-1 rounded-xl bg-sunken p-1.5 shadow-[0_0_0_1px_var(--border)] @min-[720px]:w-auto @min-[720px]:flex-col @min-[720px]:flex-nowrap">
          {TOOLS.map((t) => (
            <Tip key={t.id} label={t.hint} shortcut={[t.key]} side="right">
              <button
                type="button"
                aria-label={`${t.name} (${t.key})`}
                aria-pressed={tool === t.id}
                onClick={() => {
                  setTool(t.id);
                  setAnchor(null);
                }}
                className={toolbarButton(tool === t.id)}
              >
                <Glyph name={t.id} />
              </button>
            </Tip>
          ))}
          <span className="hidden h-px w-6 self-center bg-line @min-[720px]:block" aria-hidden="true" />
          <Tip label={MIRRORS.find((m) => m.id === mirror)?.name ?? "Mirror"} shortcut={["M"]} side="right">
            <button type="button" aria-label={`Mirror: ${MIRRORS.find((m) => m.id === mirror)?.name ?? "none"} (M cycles)`} aria-pressed={mirror !== "none"} onClick={() => setMirror(nextMirror(mirror))} className={cn(toolbarButton(mirror !== "none"), "relative")}>
              <Glyph name="mirror" />
              <span aria-hidden="true" className="absolute right-0.5 bottom-0 text-[8px] leading-none font-semibold">
                {mirror === "none" ? "" : mirror === "h" ? "H" : mirror === "v" ? "V" : "HV"}
              </span>
            </button>
          </Tip>
          {tool === "rect" || tool === "ellipse" ? (
            <Tip label={filled ? "Filled shapes" : "Outline shapes. Shift while dragging fills."} side="right">
              <button type="button" aria-label="Fill shapes" aria-pressed={filled} onClick={() => setFilled((f) => !f)} className={toolbarButton(filled)}>
                <span aria-hidden="true" className={cn("size-3.5 rounded-sm", filled ? "bg-current" : "shadow-[inset_0_0_0_1.5px_currentColor]")} />
              </button>
            </Tip>
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-1">
            {smallButton("Undo (Ctrl+Z)", "undo", undo, history.past.length === 0)}
            {smallButton("Redo (Ctrl+Shift+Z)", "redo", redo, history.future.length === 0)}
            <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
            {smallButton("Zoom out (-)", "minus", () => setZoomAdjust((z) => z - 2), zoom <= MIN_ZOOM)}
            <span className="min-w-8 text-center text-2xs tabular-nums text-subtle">{zoom}x</span>
            {smallButton("Zoom in (+)", "plus", () => setZoomAdjust((z) => z + 2), zoom >= MAX_ZOOM)}
            <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
            <Tip label="Grid lines">
              <button type="button" aria-label="Grid" aria-pressed={grid} onClick={() => setGrid((g) => !g)} className={cn("inline-flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus", grid ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
                <Glyph name="grid" size={14} />
              </button>
            </Tip>
            <Tip label="Onion skin: the previous frame, faintly">
              <button type="button" aria-label="Onion skin" aria-pressed={onion} onClick={() => setOnion((o) => !o)} disabled={!previous} className={cn("inline-flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-40", onion ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
                <Glyph name="onion" size={14} />
              </button>
            </Tip>
            <span className="ml-auto text-2xs text-subtle">
              {PIXEL_MOOD_LABELS[snap.mood]}, frame {snap.frame + 1} of {shown.frames.length}
            </span>
          </div>

          <div ref={box} className="overflow-auto rounded-lg bg-sunken p-2 shadow-[0_0_0_1px_var(--border)]">
            <div className="flex min-w-fit justify-center">
              <PixelCanvas
                ref={canvas}
                w={data.w}
                h={data.h}
                palette={data.palette}
                frame={frame}
                onion={onion ? previous : null}
                grid={grid}
                mirror={mirror}
                cursor={cursor}
                anchor={anchor}
                zoom={zoom}
                label={canvasLabel(snap, tool)}
                describedBy={statusId}
                onPointer={onPointer}
                onKeyDown={onCanvasKey}
                onFocus={() => {
                  if (!cursor) setCursor([Math.floor(data.w / 2), Math.floor(data.h / 2)]);
                }}
              />
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1">
            {smallButton("Move the frame left", "left", () => transform((f) => shiftFrame(f, data.w, data.h, -1, 0, wrap), "Moved left"))}
            {smallButton("Move the frame right", "right", () => transform((f) => shiftFrame(f, data.w, data.h, 1, 0, wrap), "Moved right"))}
            {smallButton("Move the frame up", "up", () => transform((f) => shiftFrame(f, data.w, data.h, 0, -1, wrap), "Moved up"))}
            {smallButton("Move the frame down", "down", () => transform((f) => shiftFrame(f, data.w, data.h, 0, 1, wrap), "Moved down"))}
            <label className="ml-1 flex items-center gap-1.5 text-2xs text-muted">
              <Toggle checked={wrap} onChange={setWrap} label="Wrap around when moving" />
              Wrap
            </label>
            <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
            {smallButton("Flip left to right", "flipH", () => transform((f) => flipH(f, data.w, data.h), "Flipped left to right"))}
            {smallButton("Flip top to bottom", "flipV", () => transform((f) => flipV(f, data.w, data.h), "Flipped top to bottom"))}
            {smallButton("Turn a quarter clockwise", "rotate", () => transform((f) => rotate90(f, data.w, data.h), "Turned clockwise"), data.w !== data.h)}
            {smallButton("Clear this frame", "trash", () => transform(clearFrame, "Cleared the frame"))}
          </div>
          <p id={statusId} role="status" aria-live="polite" className="mt-1.5 h-5 truncate text-xs text-muted">
            {status}
          </p>
        </div>

        <aside className="flex w-full min-w-0 flex-col gap-3 @min-[720px]:w-72 @min-[720px]:shrink-0 @min-[1040px]:w-80">
          <PalettePanel
            data={data}
            selected={colour}
            onSelect={(byte) => {
              setColourByte(byte);
              if (tool === "eraser" && byte !== 0) setTool("pencil");
            }}
            onAdd={(hex) => {
              // A colour the palette already has is picked, not added again.
              const have = data.palette.indexOf(hex.toLowerCase());
              if (have >= 0) {
                setColourByte(have + 1);
                setStatus(`${hex} is already in the palette: picked it`);
                return;
              }
              const next = addColour(data, hex);
              if (next === data) return;
              commit({ ...snap, data: next }, `Added ${hex}`);
              setColourByte(next.palette.length);
            }}
            onEdit={editColour}
            onRemove={(index) => {
              commit({ ...snap, data: removeColour(data, index) }, `Removed colour ${index + 1}; its cells are clear`);
              setColourByte((c) => (c === index + 1 ? 0 : c > index + 1 ? c - 1 : c));
            }}
            onLoad={(id) => {
              const starter = paletteById(id);
              commit({ ...snap, data: replacePalette(data, starter.colours) }, `Loaded the ${starter.name} palette`);
              setColourByte(starter.colours.length ? 1 : 0);
            }}
          />
          <FramesPanel
            snap={snap}
            playing={playing}
            onPlaying={setPlaying}
            onion={onion}
            onOnion={setOnion}
            onMood={(mood) => {
              setSnap({ ...snap, mood, frame: 0 });
              setAnchor(null);
              setStatus(`${PIXEL_MOOD_LABELS[mood]}${data.moods[mood] ? "" : " wears the resting frames"}`);
            }}
            onFrame={(index) => setSnap({ ...snap, frame: index })}
            onAdd={() => {
              const next = addFrame(snap, false);
              if (next) commit(next, "Added a blank frame");
            }}
            onDuplicate={() => {
              const next = addFrame(snap, true);
              if (next) commit(next, "Duplicated the frame");
            }}
            onDelete={() => {
              const next = deleteFrame(snap);
              if (next) commit(next, next.data.moods[snap.mood] ? "Deleted the frame" : `Deleted the frame; ${PIXEL_MOOD_LABELS[snap.mood]} wears the resting frames again`);
            }}
            onMove={(delta) => {
              const next = moveFrame(snap, delta);
              if (next) commit(next, delta < 0 ? "Moved the frame earlier" : "Moved the frame later");
            }}
            onCopyResting={() => {
              const next = copyRestingHere(snap);
              if (next) commit(next, `${PIXEL_MOOD_LABELS[snap.mood]} has its own copy of the resting frames`);
            }}
            onDropOwn={() => {
              const next = dropOwnFrames(snap);
              if (next) commit(next, `${PIXEL_MOOD_LABELS[snap.mood]} wears the resting frames again`);
            }}
            onMs={(ms) => setSnap(setMs(snap, ms))}
          />
          <PreviewPanel data={data} playing={playing} renderPreview={props.renderPreview} />
          <SizePanel data={data} onResize={(size) => commit({ ...snap, data: resizePixelData(data, size, size) }, `Resized every frame to ${size} by ${size}`)} />
          <ImportPanel
            data={data}
            onError={setLocalError}
            onPlace={(placed, palette) => {
              const next = palette ? replacePalette(data, palette) : data;
              const withFrame = setFrame({ ...snap, data: next }, snap.frame, placed);
              commit(withFrame, palette ? `Placed the picture with its ${palette.length} colours` : "Placed the picture");
              if (palette) setColourByte(palette.length ? 1 : 0);
            }}
          />
          <ExportPanel snap={snap} name={name} onError={setLocalError} />
        </aside>
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 @min-[560px]:flex-row @min-[560px]:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor={nameId} className="text-sm font-medium text-fg">
            Name
          </label>
          <input id={nameId} type="text" maxLength={MAX_NAME} value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder={DEFAULT_NAME} className="mt-1 h-9 w-full max-w-80 rounded-lg bg-sunken px-3 text-sm text-fg shadow-[0_0_0_1px_var(--border)] outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus" />
          {error ? (
            <p role="alert" className="mt-2 text-xs text-danger-text">
              {error}
            </p>
          ) : null}
        </div>
        {confirmCancel ? (
          <div className="flex flex-wrap items-center gap-2" role="alertdialog" aria-label="Discard this drawing?">
            <span className="text-xs text-muted">Discard what you drew?</span>
            <Button variant="danger" onClick={props.onCancel}>
              Discard
            </Button>
            <Button variant="secondary" autoFocus onClick={() => setConfirmCancel(false)}>
              Keep drawing
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {saveReason && !props.saving ? <span className="text-xs text-subtle">{saveReason}</span> : null}
            <Button variant="ghost" onClick={() => (history.past.length > 0 ? setConfirmCancel(true) : props.onCancel())} disabled={props.saving}>
              Cancel
            </Button>
            <Button variant="accent" onClick={() => void save()} disabled={saveReason !== null} loading={props.saving} aria-disabled={saveReason !== null} title={saveReason ?? undefined}>
              Save
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
