import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { frameToRgba, type MirrorMode, type Point } from "./pixel.js";

/**
 * The drawing surface. It paints imperatively from refs, so a stroke in progress goes straight to the canvas and
 * React is only told when the pointer comes up: nothing else on the page re-renders while the user draws. The parent
 * hands it the frame to show in between through `preview`, and hears the pointer as cells, not pixels.
 */

export interface PixelCanvasHandle {
  /** Shows this frame instead of the committed one until told otherwise (null shows the committed one again). */
  preview(frame: Uint8Array | null): void;
}

export type PointerPhase = "down" | "move" | "up";

export interface PixelCanvasProps {
  w: number;
  h: number;
  palette: readonly string[];
  frame: Uint8Array;
  /** The frame before this one, drawn faintly beneath. */
  onion?: Uint8Array | null;
  grid: boolean;
  mirror: MirrorMode;
  /** The keyboard cursor, and the first corner of a shape begun with the keyboard. */
  cursor: Point | null;
  anchor?: Point | null;
  /** Screen pixels per cell. */
  zoom: number;
  label: string;
  describedBy?: string;
  onPointer: (phase: PointerPhase, cell: Point, mods: { shift: boolean; button: number }) => void;
  onKeyDown: (event: KeyboardEvent<HTMLCanvasElement>) => void;
  onFocus?: () => void;
}

/** The two greys of the checkerboard that stands for clear: mid tones, so both white and dark ink read on it in either theme. */
const CHECK_LIGHT = "#b8b8b8";
const CHECK_DARK = "#8c8c8c";

export const PixelCanvas = forwardRef<PixelCanvasHandle, PixelCanvasProps>(function PixelCanvas(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreen = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const previewRef = useRef<Uint8Array | null>(null);
  const hoverRef = useRef<Point | null>(null);
  const dragging = useRef<Point | null>(null);
  const raf = useRef(0);

  const paint = useCallback(() => {
    raf.current = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const p = latest.current;
    const { w, h, zoom } = p;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(w * zoom * dpr);
    const ch = Math.round(h * zoom * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w * zoom, h * zoom);
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = CHECK_LIGHT;
    ctx.fillRect(0, 0, w * zoom, h * zoom);
    ctx.fillStyle = CHECK_DARK;
    for (let y = 0; y < h; y++) for (let x = (y & 1) ^ 1; x < w; x += 2) ctx.fillRect(x * zoom, y * zoom, zoom, zoom);

    const off = (offscreen.current ??= document.createElement("canvas"));
    if (off.width !== w || off.height !== h) {
      off.width = w;
      off.height = h;
    }
    const octx = off.getContext("2d");
    const blit = (frame: Uint8Array, alpha: number) => {
      if (!octx) return;
      const image = octx.createImageData(w, h);
      image.data.set(frameToRgba(p.palette, frame, w, h));
      octx.putImageData(image, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.drawImage(off, 0, 0, w * zoom, h * zoom);
      ctx.globalAlpha = 1;
    };
    if (p.onion) blit(p.onion, 0.35);
    blit(previewRef.current ?? p.frame, 1);

    if (p.grid && zoom >= 6) {
      ctx.lineWidth = 1;
      for (let x = 1; x < w; x++) {
        ctx.strokeStyle = x % 8 === 0 ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.18)";
        ctx.beginPath();
        ctx.moveTo(x * zoom + 0.5, 0);
        ctx.lineTo(x * zoom + 0.5, h * zoom);
        ctx.stroke();
      }
      for (let y = 1; y < h; y++) {
        ctx.strokeStyle = y % 8 === 0 ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.18)";
        ctx.beginPath();
        ctx.moveTo(0, y * zoom + 0.5);
        ctx.lineTo(w * zoom, y * zoom + 0.5);
        ctx.stroke();
      }
    }

    if (p.mirror !== "none") {
      ctx.save();
      ctx.strokeStyle = "rgba(60,150,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([zoom / 2, zoom / 2]);
      if (p.mirror === "h" || p.mirror === "both") {
        ctx.beginPath();
        ctx.moveTo((w * zoom) / 2, 0);
        ctx.lineTo((w * zoom) / 2, h * zoom);
        ctx.stroke();
      }
      if (p.mirror === "v" || p.mirror === "both") {
        ctx.beginPath();
        ctx.moveTo(0, (h * zoom) / 2);
        ctx.lineTo(w * zoom, (h * zoom) / 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    const outline = (cell: Point, dashed: boolean) => {
      const [x, y] = cell;
      ctx.save();
      if (dashed) ctx.setLineDash([3, 2]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.strokeRect(x * zoom + 1, y * zoom + 1, zoom - 2, zoom - 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.strokeRect(x * zoom + 1, y * zoom + 1, zoom - 2, zoom - 2);
      ctx.restore();
    };
    if (p.anchor) outline(p.anchor, true);
    if (p.cursor) outline(p.cursor, true);
    if (hoverRef.current && !dragging.current) outline(hoverRef.current, false);
  }, []);

  const schedule = useCallback(() => {
    if (!raf.current && typeof requestAnimationFrame === "function") raf.current = requestAnimationFrame(paint);
  }, [paint]);

  useImperativeHandle(
    ref,
    () => ({
      preview(frame) {
        previewRef.current = frame;
        schedule();
      },
    }),
    [schedule],
  );

  // A new committed frame means the stroke that made it has landed: show it, not the stroke's own picture.
  useEffect(() => {
    previewRef.current = null;
    schedule();
  }, [props.frame, schedule]);

  useEffect(() => {
    schedule();
  }, [props.onion, props.grid, props.mirror, props.cursor, props.anchor, props.zoom, props.palette, props.w, props.h, schedule]);

  // The pending frame is forgotten with its id: a development build mounts, unmounts and mounts again, and a stale id would
  // stop every later `schedule` from asking for a frame, leaving the canvas blank.
  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );

  const cellAt = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    const { w, h } = latest.current;
    const x = Math.floor(((event.clientX - box.left) / box.width) * w);
    const y = Math.floor(((event.clientY - box.top) / box.height) * h);
    return [Math.max(0, Math.min(w - 1, x)), Math.max(0, Math.min(h - 1, y))];
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    const cell = cellAt(event);
    dragging.current = cell;
    hoverRef.current = cell;
    latest.current.onPointer("down", cell, { shift: event.shiftKey, button: event.button });
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const cell = cellAt(event);
    const last = dragging.current;
    if (last) {
      if (last[0] !== cell[0] || last[1] !== cell[1]) {
        dragging.current = cell;
        latest.current.onPointer("move", cell, { shift: event.shiftKey, button: event.button });
      }
      return;
    }
    const hover = hoverRef.current;
    if (!hover || hover[0] !== cell[0] || hover[1] !== cell[1]) {
      hoverRef.current = cell;
      schedule();
    }
  };

  const end = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return;
    const cell = event.type === "pointercancel" ? dragging.current : cellAt(event);
    dragging.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    latest.current.onPointer("up", cell, { shift: event.shiftKey, button: event.button });
    schedule();
  };

  const onPointerLeave = () => {
    if (dragging.current) return;
    hoverRef.current = null;
    schedule();
  };

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={props.label}
      aria-describedby={props.describedBy}
      tabIndex={0}
      width={props.w}
      height={props.h}
      className="block cursor-crosshair rounded-md shadow-[0_0_0_1px_var(--border)] outline-none select-none focus-visible:ring-2 focus-visible:ring-focus"
      style={{ width: props.w * props.zoom, height: props.h * props.zoom, touchAction: "none", imageRendering: "pixelated" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={onPointerLeave}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={props.onKeyDown}
      onFocus={props.onFocus}
    />
  );
});
