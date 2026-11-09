import type { AvatarMoodId, ImagePackData } from "../../../../types.js";

/**
 * The arithmetic of bringing a picture or a sprite sheet in: which cells of a sheet have anything drawn in them, what
 * grid a sheet probably has, which row plays for which mood, and how far to shrink it so that it fits what the server keeps.
 * Pure, and working on plain pixel arrays, so it is the same in a browser, in the desktop app and in a test.
 */

export const SHEET_MOODS: readonly AvatarMoodId[] = ["idle", "working", "attention", "delight", "concern", "asleep"];

export const MOOD_WORDS: Readonly<Record<AvatarMoodId, string>> = {
  idle: "Resting",
  working: "Working",
  attention: "Needs you",
  delight: "Pleased",
  concern: "Concerned",
  asleep: "Asleep",
};

/** How long a frame shows by default, by mood: resting is slow and easy, working is brisk. */
export const MOOD_MS: Readonly<Record<AvatarMoodId, number>> = { idle: 220, working: 120, attention: 140, delight: 120, concern: 160, asleep: 320 };

/** The largest a sheet may be, per side and in pixels, and the grid it may have. */
export const MAX_SIDE_PX = 4096;
export const MAX_PIXELS = 16_000_000;
export const MAX_GRID = 16;

/** What the server will take of a picture, with room for the rest of the avatar: the picture's encoded size. */
export const MAX_PICTURE_BYTES = 440_000;

/** Whether a cell has anything in it: any pixel that is not nearly clear. */
export function cellHasArt(rgba: Uint8ClampedArray, w: number, x0: number, y0: number, cw: number, ch: number, cutoff = 12): boolean {
  for (let y = y0; y < y0 + ch; y += 1) {
    const row = y * w * 4;
    for (let x = x0; x < x0 + cw; x += 1) {
      if ((rgba[row + x * 4 + 3] ?? 0) > cutoff) return true;
    }
  }
  return false;
}

/** How many frames each row of a grid has: its cells from the left, up to the last one with something in it. A row with nothing in it has none. */
export function rowFrames(rgba: Uint8ClampedArray, w: number, h: number, cols: number, rows: number): number[] {
  const cw = Math.floor(w / cols);
  const ch = Math.floor(h / rows);
  const out: number[] = [];
  for (let r = 0; r < rows; r += 1) {
    let last = 0;
    for (let c = 0; c < cols; c += 1) if (cellHasArt(rgba, w, c * cw, r * ch, cw, ch)) last = c + 1;
    out.push(last);
  }
  return out;
}

export interface Grid {
  cols: number;
  rows: number;
}

/** A guess at a sheet's grid; `atlas` says it has the cell size desktop-pet sheets share, which is sure enough to start in sheet mode. */
export interface GridGuess extends Grid {
  atlas: boolean;
}

/** The cell of a desktop-pet sheet: 192 pixels across and 208 down. */
const ATLAS_CELL: readonly [number, number] = [192, 208];

/** Other cell sizes sheets commonly have. A picture that happens to divide into them is a guess, not a promise. */
const CELLS: readonly (readonly [number, number])[] = [[256, 256], [128, 128], [96, 96], [64, 64], [48, 48], [32, 32], [24, 24], [16, 16]];

/** The grid a sheet of this size probably has, or null when it matches no common cell size (then the user says). */
export function suggestGrid(w: number, h: number): GridGuess | null {
  const fit = (cw: number, ch: number): Grid | null => {
    if (w % cw !== 0 || h % ch !== 0) return null;
    const cols = w / cw;
    const rows = h / ch;
    // At least two cells (one is a picture), and no more than a sheet is likely to have: a grid of sixteen-pixel cells over a single picture is not a sheet.
    return cols >= 1 && rows >= 1 && cols <= MAX_GRID && rows <= MAX_GRID && cols * rows >= 2 && cols * rows <= 144 ? { cols, rows } : null;
  };
  const atlas = fit(ATLAS_CELL[0], ATLAS_CELL[1]);
  if (atlas) return { ...atlas, atlas: true };
  for (const [cw, ch] of CELLS) {
    const grid = fit(cw, ch);
    if (grid) return { ...grid, atlas: false };
  }
  return null;
}

/** Whether a drawing runs across the lines of this grid: two touching pixels with something in them on either side of a line between cells. */
function crossesGrid(rgba: Uint8ClampedArray, w: number, h: number, cols: number, rows: number, cutoff = 12): boolean {
  const cw = w / cols;
  const ch = h / rows;
  const solid = (x: number, y: number): boolean => (rgba[(y * w + x) * 4 + 3] ?? 0) > cutoff;
  for (let c = 1; c < cols; c += 1) {
    const x = Math.round(c * cw);
    for (let y = 0; y < h; y += 1) if (solid(x - 1, y) && solid(x, y)) return true;
  }
  for (let r = 1; r < rows; r += 1) {
    const y = Math.round(r * ch);
    for (let x = 0; x < w; x += 1) if (solid(x, y - 1) && solid(x, y)) return true;
  }
  return false;
}

/** How many of a grid's cells have something drawn in them. */
function occupiedCells(rgba: Uint8ClampedArray, w: number, h: number, cols: number, rows: number): number {
  const cw = Math.floor(w / cols);
  const ch = Math.floor(h / rows);
  let n = 0;
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) if (cellHasArt(rgba, w, c * cw, r * ch, cw, ch)) n += 1;
  return n;
}

/**
 * The grid a picture has, read from its pixels. A sheet keeps each frame inside its cell, so the right grid is one whose
 * lines run through nothing drawn and whose cells mostly have something in them (a finer grid over a coarse sheet passes
 * the first test but leaves most of its cells empty). Of the common cell sizes that pass both, the finest wins. A single
 * picture is drawn across the lines of any grid there is, so it has none.
 */
export function suggestGridFromPixels(rgba: Uint8ClampedArray, w: number, h: number): GridGuess | null {
  const bySize = suggestGrid(w, h);
  if (bySize?.atlas) return bySize;
  let best: GridGuess | null = null;
  for (const [cw, ch] of CELLS) {
    if (w % cw !== 0 || h % ch !== 0) continue;
    const cols = w / cw;
    const rows = h / ch;
    if (cols > MAX_GRID || rows > MAX_GRID || cols * rows < 2 || cols * rows > 144) continue;
    if (best && cols * rows <= best.cols * best.rows) continue;
    if (crossesGrid(rgba, w, h, cols, rows)) continue;
    if (occupiedCells(rgba, w, h, cols, rows) * 2 < cols * rows) continue;
    best = { cols, rows, atlas: false };
  }
  return best;
}

export interface RowPlan {
  /** The mood this row plays for, or null when the row is not used. */
  mood: AvatarMoodId | null;
  frames: number;
  ms: number;
}

const clampInt = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));

/** The rows that have something drawn in them play for the six moods, in order; any after the sixth, and any empty row, are not used until the user says. */
export function sequentialRows(frames: readonly number[]): RowPlan[] {
  let next = 0;
  return frames.map((f) => {
    const mood = f > 0 ? (SHEET_MOODS[next++] ?? null) : null;
    return { mood, frames: f, ms: mood ? MOOD_MS[mood] : 140 };
  });
}

/**
 * The layout the desktop-pet sheets seem to share, as far as it is known: resting first, then a run, then a wave, a jump
 * and a stumble. It is a starting guess, and each row can be changed, with the preview showing what it will do. A row with
 * nothing drawn in it plays for nothing.
 */
export function petRows(frames: readonly number[]): RowPlan[] {
  const map: Record<number, AvatarMoodId> = { 0: "idle", 1: "working", 3: "delight", 4: "attention", 5: "concern" };
  return frames.map((f, r) => {
    const mood = f > 0 ? (map[r] ?? null) : null;
    return { mood, frames: f, ms: mood ? MOOD_MS[mood] : 140 };
  });
}

/**
 * The sheet a plan describes. A row with nothing in it cannot play for a mood, so it is left out, and when no row plays for
 * resting the first row that has something in it does, so that the avatar always has something to show.
 */
export function sheetOf(cols: number, rows: number, plan: readonly RowPlan[]): NonNullable<ImagePackData["sheet"]> {
  const moods: NonNullable<ImagePackData["sheet"]>["moods"] = {};
  plan.forEach((p, r) => {
    if (!p.mood || r >= rows || p.frames < 1 || moods[p.mood]) return;
    moods[p.mood] = { row: r, frames: clampInt(p.frames, 1, cols), ms: clampInt(p.ms, 40, 2000) };
  });
  if (!moods.idle) {
    const first = Math.max(0, plan.findIndex((p) => p.frames > 0));
    moods.idle = { row: first, frames: clampInt(plan[first]?.frames ?? 1, 1, cols), ms: clampInt(plan[first]?.ms ?? MOOD_MS.idle, 40, 2000) };
  }
  return { cols, rows, moods };
}

/** Whether a plan has any row with something drawn in it: a sheet with none has nothing to show. */
export const hasArt = (plan: readonly RowPlan[]): boolean => plan.some((p) => p.frames > 0);

/** Which mood each row plays for, for a sheet kept earlier: the plan that makes the same sheet again. */
export function planOf(sheet: NonNullable<ImagePackData["sheet"]>): RowPlan[] {
  const plan: RowPlan[] = Array.from({ length: sheet.rows }, () => ({ mood: null, frames: 1, ms: 140 }));
  for (const mood of SHEET_MOODS) {
    const m = sheet.moods[mood];
    if (m && plan[m.row]) plan[m.row] = { mood, frames: m.frames, ms: m.ms };
  }
  return plan;
}

/**
 * How far to shrink a picture (a factor of at most 1) so that each cell is at most `maxCell` on its long side and the
 * whole is at most `maxPixels`. A face is never drawn bigger than a few hundred pixels, so the rest would be bytes for nothing.
 */
export function fitScale(w: number, h: number, cols: number, rows: number, maxCell: number, maxPixels: number): number {
  const cw = w / cols;
  const ch = h / rows;
  const byCell = maxCell / Math.max(cw, ch);
  const byTotal = Math.sqrt(maxPixels / Math.max(1, w * h));
  return Math.min(1, byCell, byTotal);
}

/** The size a sheet is stored at after shrinking by `scale`: whole cells, so that no cell bleeds into its neighbour. */
export function storedSize(w: number, h: number, cols: number, rows: number, scale: number): { cw: number; ch: number; w: number; h: number } {
  const cw = Math.max(1, Math.round((w / cols) * scale));
  const ch = Math.max(1, Math.round((h / rows) * scale));
  return { cw, ch, w: cw * cols, h: ch * rows };
}

/** Bytes a data URL carries: its base64 body, decoded. */
export function dataUrlBytes(url: string): number {
  const at = url.indexOf(",");
  const body = at < 0 ? "" : url.slice(at + 1);
  const pad = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return Math.floor((body.length * 3) / 4) - pad;
}
