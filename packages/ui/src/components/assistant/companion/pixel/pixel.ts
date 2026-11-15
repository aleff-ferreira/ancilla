import type { AvatarMoodId, PixelData } from "../../../../types.js";

/**
 * Pixel art for the assistant's face, as pure functions: frames, drawing, palettes, picture conversion, SVG paths and
 * the validator. Nothing here touches the DOM or React, so the same code runs in the studio, in the sprite renderer
 * and under node tests. Every operation returns a new frame and leaves its input alone: undo is then a list of
 * snapshots, and a stroke in progress can be previewed from the frame it started on.
 *
 * The data contract lives in `PixelData`. The server checks exactly the rules `validatePixelData` checks, so a drawing
 * that passes here is one the server keeps.
 */

// ------------------------------------------------------------------------------------------------ constants

/** The six moods, resting first: a mood without its own frames wears the resting ones. */
export const PIXEL_MOODS: readonly AvatarMoodId[] = ["idle", "working", "attention", "delight", "concern", "asleep"];

export const PIXEL_MOOD_LABELS: Readonly<Record<AvatarMoodId, string>> = {
  idle: "Resting",
  working: "Working",
  attention: "Needs you",
  delight: "Pleased",
  concern: "Concerned",
  asleep: "Asleep",
};

/** Square sizes the studio offers. The contract allows any side from 8 to 64. */
export const PIXEL_SIZES: readonly number[] = [16, 24, 32, 48, 64];
export const MIN_SIDE = 8;
export const MAX_SIDE = 64;
export const MAX_PALETTE = 32;
export const MAX_FRAMES_PER_MOOD = 8;
export const MAX_TOTAL_FRAMES = 32;
export const MIN_MS = 40;
export const MAX_MS = 2000;
/** How long a frame shows when nobody has said otherwise. */
export const DEFAULT_MS = 400;

export interface StarterPalette {
  id: string;
  name: string;
  colours: readonly string[];
}

/** A few palettes to start from. Each is at most 32 colours; the first is the one a blank canvas gets. */
export const PALETTES: readonly StarterPalette[] = [
  {
    id: "ancilla",
    name: "Ancilla",
    colours: ["#1b1f2a", "#3a3f52", "#8a90a0", "#f6d2b5", "#e0a98a", "#a86b4c", "#e5484d", "#f5a524", "#f9d94a", "#34d399", "#2a9d8f", "#3b82f6", "#8b5cf6", "#ec4899", "#e6f0ea", "#ffffff"],
  },
  {
    id: "pico",
    name: "Pico",
    colours: ["#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8", "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa"],
  },
  { id: "gameboy", name: "Gameboy", colours: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"] },
  {
    id: "pastel",
    name: "Pastel",
    colours: ["#4a4e69", "#9a8c98", "#ffd6e0", "#ffafcc", "#ffc9b9", "#fff1b8", "#d8f3dc", "#a8dadc", "#bde0fe", "#b8c0ff", "#cdb4db", "#f8edeb"],
  },
  { id: "mono", name: "Mono", colours: ["#000000", "#555555", "#aaaaaa", "#ffffff"] },
];

export const paletteById = (id: string | undefined): StarterPalette => PALETTES.find((p) => p.id === id) ?? (PALETTES[0] as StarterPalette);

/** A cell on the grid: column, then row. */
export type Point = [number, number];

/** Which axes a stroke is copied across: `h` mirrors left to right, `v` top to bottom. */
export type MirrorMode = "none" | "h" | "v" | "both";

// ------------------------------------------------------------------------------------------------ frames

export const emptyFrame = (w: number, h: number): Uint8Array => new Uint8Array(w * h);

/** A frame as base64, the form it is kept in. Chunked so a 64 by 64 frame does not overflow the argument list. */
export function packFrame(frame: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < frame.length; i += 0x2000) binary += String.fromCharCode(...frame.subarray(i, i + 0x2000));
  return btoa(binary);
}

/** The frame a base64 string holds, or null when it is not canonical base64 of exactly `w * h` bytes. */
export function unpackFrame(b64: string, w: number, h: number): Uint8Array | null {
  if (typeof b64 !== "string" || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return null;
  }
  if (binary.length !== w * h) return null;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = binary.charCodeAt(i);
  // Only one encoding is accepted for a frame, so two equal drawings are two equal strings.
  return packFrame(out) === b64 ? out : null;
}

/** An empty square canvas of `size` with the chosen starter palette and one resting frame. */
export function blankPixelData(size: number, paletteId?: string): PixelData {
  const side = Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(size)));
  return { w: side, h: side, palette: [...paletteById(paletteId).colours], moods: { idle: { ms: DEFAULT_MS, frames: [packFrame(emptyFrame(side, side))] } } };
}

export interface MoodFrames {
  ms: number;
  frames: Uint8Array[];
  /** Whether these are the mood's own frames, or the resting ones it wears. */
  own: boolean;
}

/** The frames a mood shows: its own, else the resting ones. A frame that does not decode is shown empty. */
export function framesOf(data: PixelData, mood: AvatarMoodId): MoodFrames {
  const own = data.moods[mood];
  const source = own ?? data.moods.idle;
  if (!source) return { ms: DEFAULT_MS, frames: [], own: false };
  return { ms: source.ms, frames: source.frames.map((f) => unpackFrame(f, data.w, data.h) ?? emptyFrame(data.w, data.h)), own: own !== undefined };
}

/** The data with this mood's frames replaced. No frames takes the mood away, so it wears the resting ones again; idle always stays. */
export function withFrames(data: PixelData, mood: AvatarMoodId, ms: number, frames: readonly Uint8Array[]): PixelData {
  const moods = { ...data.moods };
  if (frames.length === 0 && mood !== "idle") delete moods[mood];
  else moods[mood] = { ms, frames: frames.map(packFrame) };
  return { ...data, moods };
}

export const totalFrames = (data: PixelData): number => PIXEL_MOODS.reduce((n, m) => n + (data.moods[m]?.frames.length ?? 0), 0);

/** The same data with every frame of every mood passed through `fn`. */
export function mapFrames(data: PixelData, fn: (frame: Uint8Array, mood: AvatarMoodId, index: number) => Uint8Array, size: { w: number; h: number } = data): PixelData {
  const moods: PixelData["moods"] = {};
  for (const mood of PIXEL_MOODS) {
    const entry = data.moods[mood];
    if (!entry) continue;
    moods[mood] = { ms: entry.ms, frames: entry.frames.map((f, i) => packFrame(fn(unpackFrame(f, data.w, data.h) ?? emptyFrame(data.w, data.h), mood, i))) };
  }
  return { ...data, w: size.w, h: size.h, moods };
}

/** A new canvas size for every frame: the art keeps its place around the centre, cropped or padded with clear. */
export function resizePixelData(data: PixelData, w: number, h: number): PixelData {
  const dx = Math.floor((w - data.w) / 2);
  const dy = Math.floor((h - data.h) / 2);
  return mapFrames(
    data,
    (frame) => {
      const out = new Uint8Array(w * h);
      for (let y = 0; y < data.h; y++) {
        const ty = y + dy;
        if (ty < 0 || ty >= h) continue;
        for (let x = 0; x < data.w; x++) {
          const tx = x + dx;
          if (tx >= 0 && tx < w) out[ty * w + tx] = frame[y * data.w + x] ?? 0;
        }
      }
      return out;
    },
    { w, h },
  );
}

// ------------------------------------------------------------------------------------------------ drawing

const inside = (w: number, h: number, x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h;

/** The frame with these cells painted `colour` (0 clears). Cells off the grid are ignored. */
export function stamp(frame: Uint8Array, w: number, h: number, points: readonly Point[], colour: number): Uint8Array {
  const out = frame.slice();
  for (const [x, y] of points) if (inside(w, h, x, y)) out[y * w + x] = colour;
  return out;
}

export const plot = (frame: Uint8Array, w: number, h: number, x: number, y: number, colour: number): Uint8Array => stamp(frame, w, h, [[x, y]], colour);

/** Every cell on the straight line from one cell to another, both included (Bresenham). */
export function linePoints(x0: number, y0: number, x1: number, y1: number): Point[] {
  const points: Point[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    points.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return points;
}

export const line = (frame: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number, colour: number): Uint8Array => stamp(frame, w, h, linePoints(x0, y0, x1, y1), colour);

/** The cells of a rectangle with these corners, both included: its outline, or all of it. */
export function rectanglePoints(x0: number, y0: number, x1: number, y1: number, filled: boolean): Point[] {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const points: Point[] = [];
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      if (filled || y === top || y === bottom || x === left || x === right) points.push([x, y]);
    }
  }
  return points;
}

export const rectangle = (frame: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number, colour: number, filled: boolean): Uint8Array =>
  stamp(frame, w, h, rectanglePoints(x0, y0, x1, y1, filled), colour);

/**
 * The cells of an ellipse that fills the box with these corners, both included. A cell is in when its centre lies
 * inside the ellipse inscribed in the box, which gives the rounded shapes pixel artists expect (a 5 by 5 circle has a
 * three-cell top, a 4 by 4 one a two-cell top) and is symmetric by construction. The outline is the cells of the
 * filled shape with an unfilled neighbour, which keeps it one cell thin and connected.
 */
export function ellipsePoints(x0: number, y0: number, x1: number, y1: number, filled: boolean): Point[] {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const cx = (left + right + 1) / 2;
  const cy = (top + bottom + 1) / 2;
  const rx = (right - left + 1) / 2;
  const ry = (bottom - top + 1) / 2;
  const spans = new Map<number, [number, number]>();
  for (let y = top; y <= bottom; y++) {
    const t = (y + 0.5 - cy) / ry;
    const dx = rx * Math.sqrt(Math.max(0, 1 - t * t));
    const l = Math.max(left, Math.ceil(cx - dx - 0.5 - 1e-9));
    const r = Math.min(right, left + right - l);
    if (l <= r) spans.set(y, [l, r]);
  }
  const has = (x: number, y: number): boolean => {
    const s = spans.get(y);
    return s !== undefined && x >= s[0] && x <= s[1];
  };
  const points: Point[] = [];
  for (let y = top; y <= bottom; y++) {
    const span = spans.get(y);
    if (!span) continue;
    for (let x = span[0]; x <= span[1]; x++) {
      if (filled || !has(x - 1, y) || !has(x + 1, y) || !has(x, y - 1) || !has(x, y + 1)) points.push([x, y]);
    }
  }
  return points;
}

export const ellipse = (frame: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number, colour: number, filled: boolean): Uint8Array =>
  stamp(frame, w, h, ellipsePoints(x0, y0, x1, y1, filled), colour);

/** Paints the connected region of one colour around a cell (four-way), with an explicit stack: a 64 by 64 frame is deeper than the call stack likes. */
export function floodFill(frame: Uint8Array, w: number, h: number, x: number, y: number, colour: number): Uint8Array {
  const out = frame.slice();
  if (!inside(w, h, x, y)) return out;
  const target = out[y * w + x] ?? 0;
  if (target === colour) return out;
  const stack: number[] = [y * w + x];
  while (stack.length) {
    const i = stack.pop() as number;
    if (out[i] !== target) continue;
    out[i] = colour;
    const cx = i % w;
    if (cx > 0) stack.push(i - 1);
    if (cx < w - 1) stack.push(i + 1);
    if (i >= w) stack.push(i - w);
    if (i + w < w * h) stack.push(i + w);
  }
  return out;
}

/** The frame moved by `dx`, `dy` cells. Cells that leave the grid come back on the other side when `wrap`, else are lost. */
export function shiftFrame(frame: Uint8Array, w: number, h: number, dx: number, dy: number, wrap: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sx = x - dx;
      let sy = y - dy;
      if (wrap) {
        sx = ((sx % w) + w) % w;
        sy = ((sy % h) + h) % h;
      } else if (!inside(w, h, sx, sy)) continue;
      out[y * w + x] = frame[sy * w + sx] ?? 0;
    }
  }
  return out;
}

export function flipH(frame: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + (w - 1 - x)] = frame[y * w + x] ?? 0;
  return out;
}

export function flipV(frame: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(h - 1 - y) * w + x] = frame[y * w + x] ?? 0;
  return out;
}

/** A quarter turn clockwise. Only a square frame can turn in place; any other comes back as a copy. */
export function rotate90(frame: Uint8Array, w: number, h: number): Uint8Array {
  if (w !== h) return frame.slice();
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * w + (w - 1 - y)] = frame[y * w + x] ?? 0;
  return out;
}

export const clearFrame = (frame: Uint8Array): Uint8Array => new Uint8Array(frame.length);

/** These cells and their reflections for the mirror mode, each once, in the order first met, off-grid ones dropped. */
export function mirrored(points: readonly Point[], w: number, h: number, mode: MirrorMode): Point[] {
  const out: Point[] = [];
  const seen = new Set<number>();
  const add = (x: number, y: number) => {
    if (!inside(w, h, x, y) || seen.has(y * w + x)) return;
    seen.add(y * w + x);
    out.push([x, y]);
  };
  for (const [x, y] of points) {
    add(x, y);
    if (mode === "h" || mode === "both") add(w - 1 - x, y);
    if (mode === "v" || mode === "both") add(x, h - 1 - y);
    if (mode === "both") add(w - 1 - x, h - 1 - y);
  }
  return out;
}

/** How many cells differ between two frames of the same size: what a stroke changed. */
export function changedCells(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

// ------------------------------------------------------------------------------------------------ palette

/** The colour as `#rrggbb` in lower case, or null when it is not one. */
export const normaliseHex = (hex: string): string | null => (/^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : null);

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = (r: number, g: number, b: number): string => `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;

/** Appends a colour, up to the limit. An invalid colour, one the palette already has, or a full palette leaves the data as it is. */
export function addColour(data: PixelData, hex: string): PixelData {
  const colour = normaliseHex(hex);
  if (!colour || data.palette.length >= MAX_PALETTE || data.palette.includes(colour)) return data;
  return { ...data, palette: [...data.palette, colour] };
}

export function setColour(data: PixelData, index: number, hex: string): PixelData {
  const colour = normaliseHex(hex);
  if (!colour || index < 0 || index >= data.palette.length) return data;
  return { ...data, palette: data.palette.map((c, i) => (i === index ? colour : c)) };
}

/** Takes a colour out: its cells become clear and every higher colour moves down one, in every frame of every mood. */
export function removeColour(data: PixelData, index: number): PixelData {
  if (index < 0 || index >= data.palette.length) return data;
  const gone = index + 1;
  const next = mapFrames(data, (frame) => frame.map((c) => (c === gone ? 0 : c > gone ? c - 1 : c)));
  return { ...next, palette: data.palette.filter((_, i) => i !== index) };
}

/** The palette indices (from 0) painted somewhere in any frame, in order. */
export function usedColours(data: PixelData): number[] {
  const used = new Set<number>();
  for (const mood of PIXEL_MOODS) {
    for (const packed of data.moods[mood]?.frames ?? []) {
      const frame = unpackFrame(packed, data.w, data.h);
      if (frame) for (const c of frame) if (c > 0) used.add(c - 1);
    }
  }
  return [...used].sort((a, b) => a - b);
}

const distance2 = (a: readonly [number, number, number], b: readonly [number, number, number]): number => {
  // Red and blue weigh a little differently from green, as the eye does; good enough for picking the nearest swatch.
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
};

function nearestRgb(rgb: readonly [number, number, number], palette: readonly (readonly [number, number, number])[]): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = distance2(rgb, palette[i] as [number, number, number]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** The index (from 0) of the palette colour closest to `hex`, or -1 for an empty palette. */
export const nearestColourIndex = (hex: string, palette: readonly string[]): number => nearestRgb(hexToRgb(hex), palette.map(hexToRgb));

/** A new palette for the same art: each painted colour becomes the nearest colour of the new palette, so nothing is lost. */
export function replacePalette(data: PixelData, colours: readonly string[]): PixelData {
  const palette = colours.map((c) => normaliseHex(c) ?? "#000000").slice(0, MAX_PALETTE);
  const rgbs = palette.map(hexToRgb);
  const map = new Map<number, number>();
  for (const i of usedColours(data)) {
    const old = data.palette[i];
    map.set(i + 1, old && palette.length ? nearestRgb(hexToRgb(old), rgbs) + 1 : 0);
  }
  const next = mapFrames(data, (frame) => frame.map((c) => (c === 0 ? 0 : (map.get(c) ?? 0))));
  return { ...next, palette };
}

// ------------------------------------------------------------------------------------------------ pictures

export type ResampleMode = "nearest" | "box";

/**
 * A picture at another size. `nearest` picks the source pixel under each cell's centre, for pixel art that is already
 * crisp; `box` averages every source pixel a cell covers, weighted by alpha, so a photo shrinks without speckle.
 */
export function resample(rgba: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number, mode: ResampleMode): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const o = (y * dw + x) * 4;
      if (mode === "nearest") {
        const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
        const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
        const i = (sy * sw + sx) * 4;
        out[o] = rgba[i] ?? 0;
        out[o + 1] = rgba[i + 1] ?? 0;
        out[o + 2] = rgba[i + 2] ?? 0;
        out[o + 3] = rgba[i + 3] ?? 0;
        continue;
      }
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.ceil(((x + 1) * sw) / dw));
      const y0 = Math.floor((y * sh) / dh);
      const y1 = Math.max(y0 + 1, Math.ceil(((y + 1) * sh) / dh));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < Math.min(sh, y1); sy++) {
        for (let sx = x0; sx < Math.min(sw, x1); sx++) {
          const i = (sy * sw + sx) * 4;
          const pa = rgba[i + 3] ?? 0;
          r += (rgba[i] ?? 0) * pa;
          g += (rgba[i + 1] ?? 0) * pa;
          b += (rgba[i + 2] ?? 0) * pa;
          a += pa;
          n++;
        }
      }
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}

/** Where a picture of `sw` by `sh` sits inside `dw` by `dh` when it keeps its aspect: centred, at least one cell each way. */
export function fitInto(sw: number, sh: number, dw: number, dh: number): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(dw / Math.max(1, sw), dh / Math.max(1, sh));
  const w = Math.min(dw, Math.max(1, Math.round(sw * scale)));
  const h = Math.min(dh, Math.max(1, Math.round(sh * scale)));
  return { x: Math.floor((dw - w) / 2), y: Math.floor((dh - h) / 2), w, h };
}

export interface QuantizeOptions {
  /** How many colours the picture may use, 2 to 32. */
  maxColours: number;
  /** Alpha below this is clear. */
  alphaCutoff?: number;
  /** When given, every pixel becomes its nearest of these and no new colour is made. */
  seedPalette?: readonly string[];
}

const keyOf = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;
const rgbOfKey = (key: number): [number, number, number] => [(key >> 16) & 255, (key >> 8) & 255, key & 255];

/** Median cut over a colour histogram: the box with the widest channel is split at its weighted middle until there are `max` boxes. Deterministic. */
function medianCut(counts: Map<number, number>, max: number): number[] {
  type Box = { keys: number[] };
  const boxes: Box[] = [{ keys: [...counts.keys()].sort((a, b) => a - b) }];
  const widest = (box: Box): { channel: number; range: number } => {
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (const k of box.keys) {
      const rgb = rgbOfKey(k);
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c] as number, rgb[c] as number);
        hi[c] = Math.max(hi[c] as number, rgb[c] as number);
      }
    }
    let channel = 0;
    let range = -1;
    for (let c = 0; c < 3; c++) {
      const r = (hi[c] as number) - (lo[c] as number);
      if (r > range) {
        range = r;
        channel = c;
      }
    }
    return { channel, range };
  };
  while (boxes.length < max) {
    let pick = -1;
    let pickRange = 0;
    let pickChannel = 0;
    boxes.forEach((box, i) => {
      if (box.keys.length < 2) return;
      const { channel, range } = widest(box);
      if (range > pickRange) {
        pick = i;
        pickRange = range;
        pickChannel = channel;
      }
    });
    if (pick < 0) break;
    const box = boxes[pick] as Box;
    const sorted = [...box.keys].sort((a, b) => (rgbOfKey(a)[pickChannel] as number) - (rgbOfKey(b)[pickChannel] as number) || a - b);
    const total = sorted.reduce((n, k) => n + (counts.get(k) ?? 0), 0);
    let acc = 0;
    let cut = 0;
    while (cut < sorted.length - 1 && acc + (counts.get(sorted[cut] as number) ?? 0) < total / 2) acc += counts.get(sorted[cut++] as number) ?? 0;
    boxes.splice(pick, 1, { keys: sorted.slice(0, cut + 1) }, { keys: sorted.slice(cut + 1) });
  }
  const out: number[] = [];
  for (const box of boxes) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const k of box.keys) {
      const c = counts.get(k) ?? 0;
      const rgb = rgbOfKey(k);
      r += rgb[0] * c;
      g += rgb[1] * c;
      b += rgb[2] * c;
      n += c;
    }
    const key = n ? keyOf(Math.round(r / n), Math.round(g / n), Math.round(b / n)) : 0;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * A picture as a palette and a frame. Pixels under the alpha cutoff are clear. Without a seed palette the colours come
 * from the picture: as they are when there are few enough, else reduced by median cut, most common first.
 */
export function quantize(rgba: Uint8ClampedArray, w: number, h: number, options: QuantizeOptions): { palette: string[]; frame: Uint8Array } {
  const cutoff = options.alphaCutoff ?? 128;
  const max = Math.max(2, Math.min(MAX_PALETTE, Math.round(options.maxColours)));
  const frame = new Uint8Array(w * h);
  const opaque = (i: number): boolean => (rgba[i * 4 + 3] ?? 0) >= cutoff;
  const pixel = (i: number): [number, number, number] => [rgba[i * 4] ?? 0, rgba[i * 4 + 1] ?? 0, rgba[i * 4 + 2] ?? 0];
  if (options.seedPalette) {
    const palette = options.seedPalette.map((c) => normaliseHex(c) ?? "#000000").slice(0, MAX_PALETTE);
    const rgbs = palette.map(hexToRgb);
    if (rgbs.length) for (let i = 0; i < w * h; i++) if (opaque(i)) frame[i] = nearestRgb(pixel(i), rgbs) + 1;
    return { palette, frame };
  }
  const counts = new Map<number, number>();
  for (let i = 0; i < w * h; i++) {
    if (!opaque(i)) continue;
    const key = keyOf(...pixel(i));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keys = counts.size <= max ? [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map((e) => e[0]) : medianCut(counts, max);
  const rgbs = keys.map(rgbOfKey);
  for (let i = 0; i < w * h; i++) if (opaque(i)) frame[i] = nearestRgb(pixel(i), rgbs) + 1;
  return { palette: keys.map((k) => rgbToHex(...rgbOfKey(k))), frame };
}

// ------------------------------------------------------------------------------------------------ rendering

/** One SVG path per colour, each row's runs of that colour merged into `M x y h n v 1 h -n z` boxes; clear cells draw nothing. */
export function pixelPaths(palette: readonly string[], frame: Uint8Array, w: number, h: number): { fill: string; d: string }[] {
  const parts = new Map<number, string[]>();
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const c = frame[y * w + x] ?? 0;
      if (c === 0) {
        x++;
        continue;
      }
      let n = 1;
      while (x + n < w && frame[y * w + x + n] === c) n++;
      let list = parts.get(c);
      if (!list) parts.set(c, (list = []));
      list.push(`M${x} ${y}h${n}v1h${-n}z`);
      x += n;
    }
  }
  return [...parts.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([c]) => palette[c - 1] !== undefined)
    .map(([c, ds]) => ({ fill: palette[c - 1] as string, d: ds.join("") }));
}

/** The frame as RGBA bytes for a canvas; clear cells and unknown colours are transparent. */
export function frameToRgba(palette: readonly string[], frame: Uint8Array, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const rgbs = palette.map(hexToRgb);
  for (let i = 0; i < w * h; i++) {
    const c = frame[i] ?? 0;
    const rgb = c > 0 ? rgbs[c - 1] : undefined;
    if (!rgb) continue;
    out[i * 4] = rgb[0];
    out[i * 4 + 1] = rgb[1];
    out[i * 4 + 2] = rgb[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ validation

export type PixelCheck = { ok: true; data: PixelData } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** Checks a value against the pixel contract, field by field, and returns it in canonical form: the same rules the server applies. */
export function validatePixelData(raw: unknown): PixelCheck {
  if (!isRecord(raw)) return { ok: false, error: "Pixel data must be an object." };
  if (!intIn(raw.w, MIN_SIDE, MAX_SIDE)) return { ok: false, error: `w must be a whole number from ${MIN_SIDE} to ${MAX_SIDE}.` };
  if (!intIn(raw.h, MIN_SIDE, MAX_SIDE)) return { ok: false, error: `h must be a whole number from ${MIN_SIDE} to ${MAX_SIDE}.` };
  const w = raw.w;
  const h = raw.h;
  if (!Array.isArray(raw.palette)) return { ok: false, error: "palette must be a list of colours." };
  if (raw.palette.length > MAX_PALETTE) return { ok: false, error: `palette may hold at most ${MAX_PALETTE} colours.` };
  const palette: string[] = [];
  for (let i = 0; i < raw.palette.length; i++) {
    const colour = typeof raw.palette[i] === "string" ? normaliseHex(raw.palette[i] as string) : null;
    if (!colour) return { ok: false, error: `palette[${i}] is not a #rrggbb colour.` };
    palette.push(colour);
  }
  if (!isRecord(raw.moods)) return { ok: false, error: "moods must be an object." };
  for (const key of Object.keys(raw.moods)) {
    if (!(PIXEL_MOODS as readonly string[]).includes(key)) return { ok: false, error: `moods has an unknown mood: ${key}.` };
  }
  if (!("idle" in raw.moods)) return { ok: false, error: "moods.idle is required." };
  const moods: PixelData["moods"] = {};
  let total = 0;
  for (const mood of PIXEL_MOODS) {
    const entry = raw.moods[mood];
    if (entry === undefined) continue;
    if (!isRecord(entry)) return { ok: false, error: `moods.${mood} must be an object.` };
    if (!intIn(entry.ms, MIN_MS, MAX_MS)) return { ok: false, error: `moods.${mood}.ms must be a whole number from ${MIN_MS} to ${MAX_MS}.` };
    const ms = entry.ms;
    if (!Array.isArray(entry.frames) || entry.frames.length < 1 || entry.frames.length > MAX_FRAMES_PER_MOOD) {
      return { ok: false, error: `moods.${mood}.frames must hold 1 to ${MAX_FRAMES_PER_MOOD} frames.` };
    }
    const frames: string[] = [];
    for (let i = 0; i < entry.frames.length; i++) {
      const packed = entry.frames[i];
      const frame = typeof packed === "string" ? unpackFrame(packed, w, h) : null;
      if (!frame) return { ok: false, error: `moods.${mood}.frames[${i}] is not a valid frame of ${w * h} cells.` };
      for (const c of frame) if (c > palette.length) return { ok: false, error: `moods.${mood}.frames[${i}] uses a colour the palette does not have.` };
      frames.push(packed as string);
    }
    total += frames.length;
    moods[mood] = { ms, frames };
  }
  if (total > MAX_TOTAL_FRAMES) return { ok: false, error: `moods hold ${total} frames in all; the most is ${MAX_TOTAL_FRAMES}.` };
  return { ok: true, data: { w, h, palette, moods } };
}

// ------------------------------------------------------------------------------------------------ words

/** The size of the data as the server keeps it. */
export const pixelBytes = (data: PixelData): number => new TextEncoder().encode(JSON.stringify(data)).length;

/** One line for the library card: "16 by 16 pixel art, 7 colours, 3 moods with their own frames". */
export function describePixel(data: PixelData): string {
  const colours = data.palette.length;
  const own = PIXEL_MOODS.filter((m) => data.moods[m] !== undefined).length;
  const moods = own === 1 ? "1 mood with its own frames" : `${own} moods with their own frames`;
  return `${data.w} by ${data.h} pixel art, ${colours} colour${colours === 1 ? "" : "s"}, ${moods}`;
}
