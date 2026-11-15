import type { AvatarMoodId, PixelData } from "../../../../types.js";
import {
  DEFAULT_MS,
  MAX_FRAMES_PER_MOOD,
  MAX_MS,
  MAX_TOTAL_FRAMES,
  MIN_MS,
  PIXEL_MOOD_LABELS,
  ellipsePoints,
  emptyFrame,
  floodFill,
  framesOf,
  linePoints,
  mirrored,
  rectanglePoints,
  shiftFrame,
  stamp,
  totalFrames,
  withFrames,
  type MirrorMode,
  type MoodFrames,
  type Point,
} from "./pixel.js";

/**
 * What the studio does between a pointer going down and coming up, and what each frame button does to the data, as
 * pure functions over the editor's snapshot. The component then only wires events to these and keeps the history;
 * the rules (limits, what a mood without its own frames does when drawn on) are testable without a DOM.
 */

// ------------------------------------------------------------------------------------------------ tools

export type Tool = "pencil" | "eraser" | "fill" | "picker" | "line" | "rect" | "ellipse" | "move";

export interface ToolInfo {
  id: Tool;
  name: string;
  /** The key that picks it. */
  key: string;
  hint: string;
}

export const TOOLS: readonly ToolInfo[] = [
  { id: "pencil", name: "Pencil", key: "B", hint: "Paint cells. Right button clears." },
  { id: "eraser", name: "Eraser", key: "E", hint: "Clear cells." },
  { id: "fill", name: "Fill", key: "G", hint: "Fill a region of one colour." },
  { id: "picker", name: "Colour picker", key: "I", hint: "Take a colour from the canvas." },
  { id: "line", name: "Line", key: "L", hint: "Drag a straight line." },
  { id: "rect", name: "Rectangle", key: "R", hint: "Drag a rectangle. Shift fills it." },
  { id: "ellipse", name: "Ellipse", key: "O", hint: "Drag an ellipse. Shift fills it." },
  { id: "move", name: "Move", key: "V", hint: "Drag the whole frame." },
];

export const toolInfo = (tool: Tool): ToolInfo => TOOLS.find((t) => t.id === tool) ?? (TOOLS[0] as ToolInfo);

/** The tool a bare key press picks, if any. */
export function toolForKey(key: string): Tool | null {
  const upper = key.length === 1 ? key.toUpperCase() : key;
  return TOOLS.find((t) => t.key === upper)?.id ?? null;
}

export const MIRRORS: readonly { id: MirrorMode; name: string }[] = [
  { id: "none", name: "No mirror" },
  { id: "h", name: "Mirror left and right" },
  { id: "v", name: "Mirror top and bottom" },
  { id: "both", name: "Mirror both ways" },
];

export function nextMirror(mode: MirrorMode): MirrorMode {
  const i = MIRRORS.findIndex((m) => m.id === mode);
  return (MIRRORS[(i + 1) % MIRRORS.length] as { id: MirrorMode }).id;
}

// ------------------------------------------------------------------------------------------------ strokes

export interface StrokeState {
  tool: Tool;
  w: number;
  h: number;
  /** The byte to paint: 0 clears. */
  colour: number;
  mirror: MirrorMode;
  filled: boolean;
  wrap: boolean;
  /** The frame as it was when the stroke began: shapes and moves are drawn fresh on it each time the pointer moves. */
  base: Uint8Array;
  /** The frame with the stroke so far. */
  work: Uint8Array;
  start: Point;
  last: Point;
}

export interface StrokeStart {
  tool: Tool;
  w: number;
  h: number;
  colour: number;
  mirror: MirrorMode;
  filled: boolean;
  wrap: boolean;
  base: Uint8Array;
  at: Point;
}

/** A line, rectangle or ellipse between two cells on a frame, mirrored as asked. */
export function shapeFrame(tool: "line" | "rect" | "ellipse", base: Uint8Array, w: number, h: number, a: Point, b: Point, colour: number, filled: boolean, mirror: MirrorMode): Uint8Array {
  const points = tool === "line" ? linePoints(a[0], a[1], b[0], b[1]) : tool === "rect" ? rectanglePoints(a[0], a[1], b[0], b[1], filled) : ellipsePoints(a[0], a[1], b[0], b[1], filled);
  return stamp(base, w, h, mirrored(points, w, h, mirror), colour);
}

/** The stroke after its first sample. The picker is not a stroke: the caller reads the colour instead. */
export function startStroke(start: StrokeStart): StrokeState {
  const colour = start.tool === "eraser" ? 0 : start.colour;
  const state: StrokeState = { ...start, colour, work: start.base, start: start.at, last: start.at };
  if (start.tool === "fill") {
    let work = start.base;
    for (const [x, y] of mirrored([start.at], start.w, start.h, start.mirror)) work = floodFill(work, start.w, start.h, x, y, colour);
    return { ...state, work };
  }
  return continueStroke(state, start.at);
}

/** The stroke carried to another cell: a pencil joins the cells with a line so a fast drag leaves no gaps; a shape is redrawn from where it began. */
export function continueStroke(state: StrokeState, at: Point): StrokeState {
  switch (state.tool) {
    case "pencil":
    case "eraser": {
      const points = mirrored(linePoints(state.last[0], state.last[1], at[0], at[1]), state.w, state.h, state.mirror);
      return { ...state, work: stamp(state.work, state.w, state.h, points, state.colour), last: at };
    }
    case "line":
    case "rect":
    case "ellipse":
      return { ...state, work: shapeFrame(state.tool, state.base, state.w, state.h, state.start, at, state.colour, state.filled, state.mirror), last: at };
    case "move":
      return { ...state, work: shiftFrame(state.base, state.w, state.h, at[0] - state.start[0], at[1] - state.start[1], state.wrap), last: at };
    default:
      return { ...state, last: at };
  }
}

const cells = (n: number): string => `${n} cell${n === 1 ? "" : "s"}`;

/** What the status line says once a stroke has landed. A pencil that was painting with Clear (or the right button) clears. */
export function strokeWord(tool: Tool, changed: number, clearing = false): string {
  if (changed === 0) return "Nothing changed";
  switch (tool) {
    case "pencil":
      return clearing ? `Cleared ${cells(changed)}` : `Painted ${cells(changed)}`;
    case "eraser":
      return `Cleared ${cells(changed)}`;
    case "fill":
      return `Filled ${cells(changed)}`;
    case "line":
      return `Drew a line of ${cells(changed)}`;
    case "rect":
      return "Drew a rectangle";
    case "ellipse":
      return "Drew an ellipse";
    case "move":
      return "Moved the frame";
    default:
      return "Changed the frame";
  }
}

// ------------------------------------------------------------------------------------------------ the editor's snapshot

/** Everything undo restores: the data and which frame was in view. */
export interface EditorSnapshot {
  data: PixelData;
  mood: AvatarMoodId;
  frame: number;
}

export const HISTORY_LIMIT = 200;

export interface History {
  past: EditorSnapshot[];
  future: EditorSnapshot[];
}

/** A step taken: the snapshot before it is kept, and whatever was undone is forgotten. */
export function pushHistory(history: History, before: EditorSnapshot): History {
  const past = [...history.past, before];
  return { past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past, future: [] };
}

export const currentFrames = (snap: EditorSnapshot): MoodFrames => framesOf(snap.data, snap.mood);

/** The frame in view, empty when the data has none. */
export function currentFrame(snap: EditorSnapshot): Uint8Array {
  const shown = currentFrames(snap);
  return shown.frames[snap.frame] ?? shown.frames[0] ?? emptyFrame(snap.data.w, snap.data.h);
}

/** Whether every cell of the resting frames is clear: nothing to save yet. */
export function idleIsEmpty(data: PixelData): boolean {
  return framesOf(data, "idle").frames.every((frame) => frame.every((c) => c === 0));
}

/**
 * One frame replaced. Drawing on a mood that wears the resting frames gives it its own first: a copy of the resting
 * ones with the change on the one in view, so the user sees the frames they were looking at and nothing else moves.
 */
export function setFrame(snap: EditorSnapshot, index: number, frame: Uint8Array): EditorSnapshot {
  const shown = currentFrames(snap);
  const frames = shown.frames.length ? shown.frames.map((f, i) => (i === index ? frame : f)) : [frame];
  return { ...snap, data: withFrames(snap.data, snap.mood, shown.ms, frames) };
}

/** Why another frame cannot be added to this mood, or null when it can. */
export function frameLimitReason(snap: EditorSnapshot): string | null {
  const shown = currentFrames(snap);
  const ownCount = shown.own ? shown.frames.length : 0;
  if (ownCount >= MAX_FRAMES_PER_MOOD) return `A mood has at most ${MAX_FRAMES_PER_MOOD} frames`;
  // A mood that wears the resting frames takes a copy of them when it gets its own, so that many count too.
  const added = shown.own ? 1 : shown.frames.length + 1;
  if (totalFrames(snap.data) + added > MAX_TOTAL_FRAMES) return `All moods together have at most ${MAX_TOTAL_FRAMES} frames`;
  return null;
}

/** A new frame after the one in view: blank, or a copy of it. Null when a limit says no. */
export function addFrame(snap: EditorSnapshot, duplicate: boolean): EditorSnapshot | null {
  if (frameLimitReason(snap)) return null;
  const shown = currentFrames(snap);
  const frames = [...shown.frames];
  const at = Math.min(snap.frame, Math.max(0, frames.length - 1));
  const fresh = duplicate ? (frames[at] ?? emptyFrame(snap.data.w, snap.data.h)).slice() : emptyFrame(snap.data.w, snap.data.h);
  frames.splice(frames.length ? at + 1 : 0, 0, fresh);
  return { ...snap, frame: frames.length ? at + 1 : 0, data: withFrames(snap.data, snap.mood, shown.ms, frames) };
}

/** Why the frame in view cannot be deleted, or null when it can. */
export function deleteReason(snap: EditorSnapshot): string | null {
  const shown = currentFrames(snap);
  if (!shown.own) return "This mood wears the resting frames";
  if (shown.frames.length <= 1 && snap.mood === "idle") return "The resting mood keeps at least one frame";
  return null;
}

/** The frame in view taken away. The last frame of another mood leaves it wearing the resting frames again. */
export function deleteFrame(snap: EditorSnapshot): EditorSnapshot | null {
  if (deleteReason(snap)) return null;
  const shown = currentFrames(snap);
  const frames = shown.frames.filter((_, i) => i !== snap.frame);
  return { ...snap, frame: Math.max(0, Math.min(snap.frame, frames.length - 1)), data: withFrames(snap.data, snap.mood, shown.ms, frames) };
}

/** The frame in view swapped with a neighbour. Null when there is no neighbour that way or the frames are not the mood's own. */
export function moveFrame(snap: EditorSnapshot, delta: -1 | 1): EditorSnapshot | null {
  const shown = currentFrames(snap);
  const to = snap.frame + delta;
  if (!shown.own || to < 0 || to >= shown.frames.length) return null;
  const frames = [...shown.frames];
  const a = frames[snap.frame] as Uint8Array;
  frames[snap.frame] = frames[to] as Uint8Array;
  frames[to] = a;
  return { ...snap, frame: to, data: withFrames(snap.data, snap.mood, shown.ms, frames) };
}

/** Gives a mood a copy of the resting frames to work from. Null when it has its own already or the total would pass the limit. */
export function copyRestingHere(snap: EditorSnapshot): EditorSnapshot | null {
  if (snap.mood === "idle" || snap.data.moods[snap.mood]) return null;
  const idle = framesOf(snap.data, "idle");
  if (totalFrames(snap.data) + idle.frames.length > MAX_TOTAL_FRAMES) return null;
  return { ...snap, frame: 0, data: withFrames(snap.data, snap.mood, idle.ms, idle.frames.map((f) => f.slice())) };
}

/** Drops a mood's own frames so it wears the resting ones again. The resting mood keeps its own. */
export function dropOwnFrames(snap: EditorSnapshot): EditorSnapshot | null {
  if (snap.mood === "idle" || !snap.data.moods[snap.mood]) return null;
  return { ...snap, frame: 0, data: withFrames(snap.data, snap.mood, DEFAULT_MS, []) };
}

/** How long each of this mood's frames shows, within the contract's range. */
export function setMs(snap: EditorSnapshot, ms: number): EditorSnapshot {
  const shown = currentFrames(snap);
  if (!shown.own) return snap;
  const clamped = Math.max(MIN_MS, Math.min(MAX_MS, Math.round(ms)));
  return { ...snap, data: withFrames(snap.data, snap.mood, clamped, shown.frames) };
}

/** What a screen reader hears for the canvas. */
export function canvasLabel(snap: EditorSnapshot, tool: Tool): string {
  const shown = currentFrames(snap);
  const mood = PIXEL_MOOD_LABELS[snap.mood];
  const which = shown.own ? `frame ${snap.frame + 1} of ${shown.frames.length}` : "wearing the resting frames";
  return `Pixel canvas, ${snap.data.w} by ${snap.data.h} cells, ${mood}, ${which}. Arrow keys move the cursor; Space or Enter uses the ${toolInfo(tool).name.toLowerCase()}.`;
}
