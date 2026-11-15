import { useEffect, useMemo, useState } from "react";
import type { AvatarMoodId, PixelData } from "../../../../types.js";
import { framesOf, pixelPaths } from "./pixel.js";

/**
 * Pixel art inside the avatar's 160-unit box. It only cycles frames; how the whole sprite moves for a mood (a bob, a
 * hop, a shiver) is the stylesheet's, on `.av-sprite`, so a drawn face and a built-in one share one set of motions.
 * Frame cycling stops when the user asked for less motion, while the page is hidden, or when `paused`.
 */

/** Where the art sits: centred, standing on the floor at y 144, as large as a 120 by 120 box allows. */
export function spriteTransform(w: number, h: number): { x: number; y: number; scale: number } {
  const scale = 120 / Math.max(1, w, h);
  return { x: 80 - (w * scale) / 2, y: 144 - h * scale, scale };
}

const round = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ""));

export function PixelSprite(props: { data: PixelData; mood: AvatarMoodId; paused?: boolean }) {
  const { data, mood, paused = false } = props;
  const shown = useMemo(() => framesOf(data, mood), [data, mood]);
  const paths = useMemo(() => shown.frames.map((frame) => pixelPaths(data.palette, frame, data.w, data.h)), [shown, data.palette, data.w, data.h]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    if (paused || shown.frames.length < 2 || typeof document === "undefined") return undefined;
    const reduced = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
      setIndex(0);
    };
    const sync = () => {
      if (document.hidden || reduced?.matches) stop();
      else if (!timer) timer = setInterval(() => setIndex((i) => (i + 1) % shown.frames.length), shown.ms);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    reduced?.addEventListener?.("change", sync);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", sync);
      reduced?.removeEventListener?.("change", sync);
    };
  }, [shown, paused]);

  const { x, y, scale } = spriteTransform(data.w, data.h);
  const current = paths[index] ?? paths[0] ?? [];
  return (
    <g className="av-sprite">
      <g transform={`translate(${round(x)} ${round(y)}) scale(${round(scale)})`}>
        {current.map((p) => (
          <path key={p.fill} d={p.d} fill={p.fill} shapeRendering="crispEdges" />
        ))}
      </g>
    </g>
  );
}
