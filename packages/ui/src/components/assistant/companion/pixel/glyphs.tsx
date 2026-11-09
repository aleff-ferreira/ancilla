/**
 * The small marks on the studio's buttons, drawn here as plain strokes. The product's icon set is imported from one
 * module and these are only wanted on this one panel, so they stay beside it rather than widening that set.
 */

export type GlyphName =
  | "pencil"
  | "eraser"
  | "fill"
  | "picker"
  | "line"
  | "rect"
  | "ellipse"
  | "move"
  | "undo"
  | "redo"
  | "plus"
  | "minus"
  | "play"
  | "pause"
  | "trash"
  | "copy"
  | "left"
  | "right"
  | "up"
  | "down"
  | "grid"
  | "mirror"
  | "onion"
  | "flipH"
  | "flipV"
  | "rotate";

const PATHS: Record<GlyphName, string> = {
  pencil: "M3 13l1-4 7-7 3 3-7 7-4 1z M10 3l3 3",
  eraser: "M9 3l4 4-6 6H4l-1-1 6-9z M6 7l4 4 M3 13h10",
  fill: "M3 8l5-5 5 5-5 5z M3 8h10 M13 9.5c0 1.5-1 2.5-1 2.5s-1-1-1-2.5 1-2 1-2 1 .5 1 2z",
  picker: "M12.5 3.5l-2-2-2 2 2 2 2-2z M9 5l-5 5v2h2l5-5",
  line: "M3 13L13 3",
  rect: "M3 4h10v8H3z",
  ellipse: "M8 4c3 0 5.5 1.8 5.5 4S11 12 8 12 2.5 10.2 2.5 8 5 4 8 4z",
  move: "M8 2v12 M2 8h12 M6 4l2-2 2 2 M6 12l2 2 2-2 M4 6L2 8l2 2 M12 6l2 2-2 2",
  undo: "M6 4L3 7l3 3 M3 7h6a3.5 3.5 0 0 1 0 7H7",
  redo: "M10 4l3 3-3 3 M13 7H7a3.5 3.5 0 0 0 0 7h2",
  plus: "M8 3v10 M3 8h10",
  minus: "M3 8h10",
  play: "M5 3l8 5-8 5z",
  pause: "M5.5 3v10 M10.5 3v10",
  trash: "M3 5h10 M6 5V3h4v2 M5 5l1 8h4l1-8",
  copy: "M5 5h8v8H5z M3 11V3h8",
  left: "M10 3L5 8l5 5",
  right: "M6 3l5 5-5 5",
  up: "M3 10l5-5 5 5",
  down: "M3 6l5 5 5-5",
  grid: "M3 3h10v10H3z M3 8h10 M8 3v10",
  mirror: "M8 2v12 M5 5L3 8l2 3 M11 5l2 3-2 3",
  onion: "M3 6h7v7H3z M6 3h7v7",
  flipH: "M8 2v12 M6 5H3v6h3 M10 5h3v6h-3",
  flipV: "M2 8h12 M5 6V3h6v3 M5 10v3h6v-3",
  rotate: "M12 7A4.5 4.5 0 1 0 11 11 M12 3v4H8",
};

export function Glyph(props: { name: GlyphName; size?: number; className?: string }) {
  const size = props.size ?? 16;
  const filled = props.name === "play";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className={props.className} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={props.name === "pause" ? 2 : 1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[props.name]} />
    </svg>
  );
}
