import { useEffect, useState, type ReactNode } from "react";
import type { ImagePackData, PixelData } from "../../../types.js";
import type { AvatarMood } from "./faces.js";
import { framesOf } from "./pixel/pixel.js";
import { PixelSprite } from "./pixel/PixelSprite.js";

/**
 * A picture the user brought, drawn as an avatar: one picture, or a sprite sheet (a grid of frames, one row for each mood
 * that has its own). A mood that has no frames of its own wears the resting ones and moves in its own way, which the
 * stylesheet does to `.av-motion`; a mood that has them plays them, and the motion steps back to a quiet breath.
 */

/**
 * Which frame of an animation to show now: it advances every `ms` while the page is visible and the user has not asked for
 * less motion, and holds the first frame otherwise.
 */
export function useFrameClock(count: number, ms: number, paused = false): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    setFrame(0);
  }, [count, ms]);
  useEffect(() => {
    if (count <= 1 || paused) return undefined;
    if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined;
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const sync = () => {
      stop();
      if (document.visibilityState !== "hidden") timer = window.setInterval(() => setFrame((f) => (f + 1) % count), Math.max(40, ms));
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [count, ms, paused]);
  return count <= 1 ? 0 : frame % count;
}

/** The ground a picture or a pixel sprite stands on, so it is not floating in the dark. */
export function Ground() {
  return <ellipse cx="80" cy="147" rx="36" ry="5.4" className="fg-ground" />;
}

/** Wraps sprite content in the group the stylesheet moves: breath at rest, and a hop, a bounce or a shiver by mood. */
export function Motion(props: { own: boolean; children: ReactNode }) {
  return (
    <g className="av-motion" data-own={props.own ? "true" : "false"}>
      {props.children}
    </g>
  );
}

/** Pixel art, standing on the ground, moving by mood unless it has frames of its own for this one. */
export function PixelLook({ data, mood }: { data: PixelData; mood: AvatarMood }) {
  return (
    <>
      <Ground />
      <Motion own={framesOf(data, mood).own}>
        <PixelSprite data={data} mood={mood} />
      </Motion>
    </>
  );
}

/** The cell of a sheet (or the whole picture) that plays for this mood, as a nested viewport onto the picture. */
export function ImageSprite({ data, mood }: { data: ImagePackData; mood: AvatarMood }) {
  const sheet = data.sheet;
  const row = sheet ? (sheet.moods[mood] ?? sheet.moods.idle) : undefined;
  const own = Boolean(sheet?.moods[mood]);
  const frames = sheet && row ? Math.max(1, Math.min(row.frames, sheet.cols)) : 1;
  const frame = useFrameClock(frames, row?.ms ?? 160);
  const cols = sheet?.cols ?? 1;
  const rows = sheet?.rows ?? 1;
  const cw = data.w / cols;
  const ch = data.h / rows;
  const scale = Math.min(120 / cw, 120 / ch);
  const bw = cw * scale;
  const bh = ch * scale;
  return (
    <>
      <Ground />
      <Motion own={own}>
        <svg x={80 - bw / 2} y={144 - bh} width={bw} height={bh} viewBox={`${frame * cw} ${(row?.row ?? 0) * ch} ${cw} ${ch}`} aria-hidden="true">
          <image href={data.src} x="0" y="0" width={data.w} height={data.h} preserveAspectRatio="none" style={{ imageRendering: data.crisp ? "pixelated" : "auto" }} />
        </svg>
      </Motion>
    </>
  );
}
