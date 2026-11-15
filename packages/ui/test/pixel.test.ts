import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_FRAMES_PER_MOOD,
  MAX_PALETTE,
  MAX_TOTAL_FRAMES,
  PALETTES,
  PIXEL_MOODS,
  PIXEL_MOOD_LABELS,
  PIXEL_SIZES,
  addColour,
  blankPixelData,
  changedCells,
  clearFrame,
  describePixel,
  ellipse,
  ellipsePoints,
  emptyFrame,
  fitInto,
  flipH,
  flipV,
  floodFill,
  frameToRgba,
  framesOf,
  line,
  linePoints,
  mirrored,
  nearestColourIndex,
  packFrame,
  pixelBytes,
  pixelPaths,
  plot,
  quantize,
  rectangle,
  removeColour,
  replacePalette,
  resample,
  resizePixelData,
  rotate90,
  setColour,
  shiftFrame,
  stamp,
  totalFrames,
  unpackFrame,
  usedColours,
  validatePixelData,
  withFrames,
} from "../src/components/assistant/companion/pixel/pixel.js";
import { PixelSprite, spriteTransform } from "../src/components/assistant/companion/pixel/PixelSprite.js";
import {
  addFrame,
  canvasLabel,
  continueStroke,
  copyRestingHere,
  deleteFrame,
  deleteReason,
  dropOwnFrames,
  frameLimitReason,
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
  type EditorSnapshot,
} from "../src/components/assistant/companion/pixel/tools.js";
import type { AvatarMoodId, PixelData } from "../src/types.js";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const list = (frame: Uint8Array): number[] => [...frame];

/** A 2 by 2 drawing with three colours and two moods. */
function sample(): PixelData {
  return {
    w: 2,
    h: 2,
    palette: ["#ff0000", "#00ff00", "#0000ff"],
    moods: {
      idle: { ms: 400, frames: [packFrame(bytes(1, 2, 3, 0))] },
      working: { ms: 120, frames: [packFrame(bytes(3, 3, 2, 1)), packFrame(bytes(0, 0, 0, 1))] },
    },
  };
}

describe("frames in and out of base64", () => {
  it("packs and unpacks a frame, and refuses what is not a frame", () => {
    const frame = bytes(0, 1, 2, 0);
    const packed = packFrame(frame);
    assert.equal(packed, "AAECAA==");
    assert.deepEqual(list(unpackFrame(packed, 2, 2) as Uint8Array), [0, 1, 2, 0]);
    assert.equal(unpackFrame(packed, 2, 3), null, "the wrong size is not a frame");
    assert.equal(unpackFrame("AAECAA", 2, 2), null, "a length that is not a multiple of four is not base64");
    assert.equal(unpackFrame("AA$CAA==", 2, 2), null, "a character outside the alphabet");
    assert.equal(unpackFrame("AAECAB==", 2, 2), null, "the same bytes spelt another way are refused, so equal drawings are equal strings");
    assert.equal(unpackFrame(123 as unknown as string, 2, 2), null);
    const big = emptyFrame(64, 64);
    big[4095] = 32;
    assert.deepEqual(list(unpackFrame(packFrame(big), 64, 64) as Uint8Array), list(big), "the largest frame goes round in one piece");
  });

  it("starts a blank canvas with one resting frame and the chosen palette", () => {
    const blank = blankPixelData(16, "gameboy");
    assert.equal(blank.w, 16);
    assert.equal(blank.h, 16);
    assert.deepEqual(blank.palette, ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"]);
    assert.deepEqual(Object.keys(blank.moods), ["idle"]);
    assert.equal(blank.moods.idle?.ms, 400);
    assert.deepEqual(list(framesOf(blank, "idle").frames[0] as Uint8Array), list(emptyFrame(16, 16)));
    assert.deepEqual(blankPixelData(24).palette, [...(PALETTES[0] as { colours: readonly string[] }).colours], "the first starter palette when none is named");
    assert.equal(blankPixelData(1000).w, 64, "a size past the contract is brought back inside it");
    assert.ok(validatePixelData(blank).ok);
  });

  it("gives a mood its own frames, else the resting ones, and drops a mood whose frames are taken away", () => {
    const data = sample();
    const own = framesOf(data, "working");
    assert.equal(own.own, true);
    assert.equal(own.ms, 120);
    assert.deepEqual(own.frames.map(list), [[3, 3, 2, 1], [0, 0, 0, 1]]);
    const worn = framesOf(data, "asleep");
    assert.equal(worn.own, false);
    assert.equal(worn.ms, 400);
    assert.deepEqual(worn.frames.map(list), [[1, 2, 3, 0]]);
    const dropped = withFrames(data, "working", 120, []);
    assert.equal(dropped.moods.working, undefined);
    assert.ok(data.moods.working, "the original is left alone");
    const kept = withFrames(data, "idle", 400, []);
    assert.ok(kept.moods.idle, "the resting mood is never dropped");
    const added = withFrames(data, "delight", 90, [bytes(1, 1, 1, 1)]);
    assert.deepEqual(added.moods.delight, { ms: 90, frames: [packFrame(bytes(1, 1, 1, 1))] });
    assert.equal(totalFrames(data), 3);
    assert.equal(totalFrames(added), 4);
  });

  it("resizes every frame around the centre, and back again without loss", () => {
    const data = { ...sample(), moods: { idle: { ms: 400, frames: [packFrame(bytes(1, 2, 3, 4))] } }, palette: ["#000000", "#111111", "#222222", "#333333"] };
    const larger = resizePixelData(data, 4, 4);
    assert.equal(larger.w, 4);
    assert.deepEqual(list(framesOf(larger, "idle").frames[0] as Uint8Array), [0, 0, 0, 0, 0, 1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 0]);
    assert.deepEqual(list(framesOf(resizePixelData(larger, 2, 2), "idle").frames[0] as Uint8Array), [1, 2, 3, 4]);
    assert.deepEqual(list(framesOf(resizePixelData(data, 1, 1), "idle").frames[0] as Uint8Array), [4], "shrinking by an odd amount keeps the lower right of the centre");
  });
});

describe("drawing on a frame", () => {
  const F = bytes(1, 2, 3, 4, 5, 6, 7, 8, 9);

  it("plots one cell without touching the frame it was given", () => {
    const empty = emptyFrame(3, 3);
    const dot = plot(empty, 3, 3, 1, 1, 5);
    assert.deepEqual(list(dot), [0, 0, 0, 0, 5, 0, 0, 0, 0]);
    assert.deepEqual(list(empty), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(list(plot(empty, 3, 3, 5, 5, 1)), list(empty), "a cell off the grid is ignored");
    assert.deepEqual(list(stamp(empty, 3, 3, [[0, 0], [2, 2], [-1, 0]], 7)), [7, 0, 0, 0, 0, 0, 0, 0, 7]);
    assert.deepEqual(list(clearFrame(F)), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(changedCells(F, plot(F, 3, 3, 0, 0, 1)), 0);
    assert.equal(changedCells(F, clearFrame(F)), 9);
  });

  it("draws lines that reach both ends, shallow or steep, the same either way round", () => {
    assert.deepEqual(linePoints(0, 0, 3, 1), [[0, 0], [1, 0], [2, 1], [3, 1]]);
    assert.deepEqual(linePoints(0, 0, 1, 3), [[0, 0], [0, 1], [1, 2], [1, 3]]);
    assert.deepEqual(linePoints(2, 2, 2, 2), [[2, 2]], "a line to itself is one cell");
    const forward = linePoints(1, 7, 9, 2);
    const back = linePoints(9, 2, 1, 7);
    assert.deepEqual(forward[0], [1, 7]);
    assert.deepEqual(forward[forward.length - 1], [9, 2]);
    assert.equal(forward.length, 9, "one cell per column on a shallow line");
    assert.equal(back.length, 9);
    for (let i = 1; i < forward.length; i++) {
      const [ax, ay] = forward[i - 1] as [number, number];
      const [bx, by] = forward[i] as [number, number];
      assert.ok(Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1, "no gaps between neighbours");
    }
    assert.deepEqual(list(line(emptyFrame(4, 2), 4, 2, 0, 0, 3, 1, 1)), [1, 1, 0, 0, 0, 0, 1, 1]);
  });

  it("draws a rectangle as an outline or filled, whichever corner comes first", () => {
    const outline = rectangle(emptyFrame(4, 4), 4, 4, 3, 3, 0, 0, 1, false);
    assert.deepEqual(list(outline), [1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1]);
    assert.deepEqual(list(rectangle(emptyFrame(4, 4), 4, 4, 0, 0, 3, 3, 1, true)), new Array(16).fill(1));
    assert.deepEqual(list(rectangle(emptyFrame(3, 3), 3, 3, 1, 1, 1, 1, 2, false)), [0, 0, 0, 0, 2, 0, 0, 0, 0]);
  });

  it("draws round ellipses that are symmetric both ways", () => {
    assert.deepEqual(ellipsePoints(0, 0, 4, 4, false), [[1, 0], [2, 0], [3, 0], [0, 1], [4, 1], [0, 2], [4, 2], [0, 3], [4, 3], [1, 4], [2, 4], [3, 4]]);
    assert.deepEqual(ellipsePoints(0, 0, 3, 3, false), [[1, 0], [2, 0], [0, 1], [3, 1], [0, 2], [3, 2], [1, 3], [2, 3]]);
    assert.equal(ellipsePoints(0, 0, 3, 3, true).length, 12);
    assert.deepEqual(list(ellipse(emptyFrame(7, 3), 7, 3, 0, 0, 6, 2, 1, false)), [0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 0]);
    for (const [w, h] of [[9, 9], [10, 6], [5, 12], [2, 2], [1, 5]] as [number, number][]) {
      const points = ellipsePoints(0, 0, w - 1, h - 1, false);
      const has = new Set(points.map(([x, y]) => `${x},${y}`));
      for (const [x, y] of points) {
        assert.ok(has.has(`${w - 1 - x},${y}`), `${w} by ${h}: (${x}, ${y}) has its left-right twin`);
        assert.ok(has.has(`${x},${h - 1 - y}`), `${w} by ${h}: (${x}, ${y}) has its top-bottom twin`);
      }
      assert.ok(points.length > 0);
    }
    assert.deepEqual(ellipsePoints(2, 2, 2, 2, false), [[2, 2]], "one cell is one cell");
  });

  it("fills a region through its sides and not its corners", () => {
    const room = bytes(1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1);
    assert.deepEqual(list(floodFill(room, 4, 4, 1, 1, 2)), [1, 1, 1, 1, 1, 2, 2, 1, 1, 2, 1, 1, 1, 1, 1, 1]);
    const diagonal = bytes(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0);
    assert.deepEqual(list(floodFill(diagonal, 4, 4, 0, 0, 2)), [2, 2, 1, 0, 2, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], "a diagonal wall holds");
    assert.deepEqual(list(floodFill(diagonal, 4, 4, 3, 3, 2)), [0, 0, 1, 2, 0, 1, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2]);
    assert.deepEqual(list(floodFill(room, 4, 4, 0, 0, 1)), list(room), "filling a colour with itself changes nothing");
    assert.deepEqual(list(floodFill(room, 4, 4, 9, 9, 2)), list(room), "off the grid does nothing");
    const wide = emptyFrame(64, 64);
    assert.ok(floodFill(wide, 64, 64, 0, 0, 1).every((c) => c === 1), "the largest frame fills without a deep stack");
    assert.deepEqual(list(room), [1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1], "the frame given is untouched");
  });

  it("moves a frame with wrapping or clipping, flips it and turns it", () => {
    assert.deepEqual(list(shiftFrame(F, 3, 3, 1, 0, true)), [3, 1, 2, 6, 4, 5, 9, 7, 8]);
    assert.deepEqual(list(shiftFrame(F, 3, 3, 1, 0, false)), [0, 1, 2, 0, 4, 5, 0, 7, 8]);
    assert.deepEqual(list(shiftFrame(F, 3, 3, 0, -1, true)), [4, 5, 6, 7, 8, 9, 1, 2, 3]);
    assert.deepEqual(list(shiftFrame(F, 3, 3, 0, 1, false)), [0, 0, 0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(list(shiftFrame(F, 3, 3, 3, 3, true)), list(F), "a whole turn is no move");
    assert.deepEqual(list(shiftFrame(F, 3, 3, 3, 0, false)), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(list(flipH(F, 3, 3)), [3, 2, 1, 6, 5, 4, 9, 8, 7]);
    assert.deepEqual(list(flipV(F, 3, 3)), [7, 8, 9, 4, 5, 6, 1, 2, 3]);
    assert.deepEqual(list(rotate90(F, 3, 3)), [7, 4, 1, 8, 5, 2, 9, 6, 3]);
    assert.deepEqual(list(rotate90(rotate90(rotate90(rotate90(F, 3, 3), 3, 3), 3, 3), 3, 3)), list(F));
    assert.deepEqual(list(rotate90(bytes(1, 2), 2, 1)), [1, 2], "a frame that is not square comes back as it was");
  });

  it("mirrors points across the axes asked for, each once", () => {
    assert.deepEqual(mirrored([[0, 1]], 4, 4, "none"), [[0, 1]]);
    assert.deepEqual(mirrored([[0, 1]], 4, 4, "h"), [[0, 1], [3, 1]]);
    assert.deepEqual(mirrored([[0, 1]], 4, 4, "v"), [[0, 1], [0, 2]]);
    assert.deepEqual(mirrored([[0, 1]], 4, 4, "both"), [[0, 1], [3, 1], [0, 2], [3, 2]]);
    assert.deepEqual(mirrored([[1, 1]], 3, 3, "both"), [[1, 1]], "the centre of an odd grid is its own twin");
    assert.deepEqual(mirrored([[0, 0], [3, 0]], 4, 4, "h"), [[0, 0], [3, 0]], "a twin already in the list is not added twice");
    assert.deepEqual(mirrored([[7, 0]], 4, 4, "both"), [], "a point off the grid has no place");
  });
});

describe("the palette", () => {
  it("adds, edits and removes colours, and removing one clears its cells and shifts the rest in every frame", () => {
    const data = sample();
    assert.deepEqual(addColour(data, "#ABCDEF").palette, ["#ff0000", "#00ff00", "#0000ff", "#abcdef"]);
    assert.equal(addColour(data, "blue"), data, "not a colour: nothing happens");
    assert.deepEqual(setColour(data, 1, "#123456").palette, ["#ff0000", "#123456", "#0000ff"]);
    assert.equal(setColour(data, 9, "#123456"), data);
    const removed = removeColour(data, 1);
    assert.deepEqual(removed.palette, ["#ff0000", "#0000ff"]);
    assert.deepEqual(framesOf(removed, "idle").frames.map(list), [[1, 0, 2, 0]]);
    assert.deepEqual(framesOf(removed, "working").frames.map(list), [[2, 2, 0, 1], [0, 0, 0, 1]]);
    assert.equal(removed.moods.working?.ms, 120, "timing stays");
    assert.deepEqual(data.palette, ["#ff0000", "#00ff00", "#0000ff"], "the original is left alone");
    assert.equal(addColour(data, "#FF0000"), data, "a colour the palette has is not added twice, whatever its case");
    let full = data;
    for (let i = 0; full.palette.length < MAX_PALETTE; i += 1) full = addColour(full, `#${(0x101010 + i).toString(16)}`);
    assert.equal(addColour(full, "#111111"), full, "a full palette takes no more");
  });

  it("knows which colours are in use and the nearest colour to another", () => {
    assert.deepEqual(usedColours(sample()), [0, 1, 2]);
    assert.deepEqual(usedColours(withFrames(sample(), "working", 100, [])), [0, 1, 2]);
    assert.deepEqual(usedColours(blankPixelData(8)), []);
    assert.equal(nearestColourIndex("#fe0000", ["#0000ff", "#ff0000", "#00ff00"]), 1);
    assert.equal(nearestColourIndex("#000000", []), -1);
  });

  it("swaps a palette for another by moving each colour in use to its nearest, so the drawing stays", () => {
    const data = sample();
    const close = replacePalette(data, ["#EE0000", "#0000ee", "#00ff00"]);
    assert.deepEqual(close.palette, ["#ee0000", "#0000ee", "#00ff00"]);
    assert.deepEqual(framesOf(close, "idle").frames.map(list), [[1, 3, 2, 0]]);
    assert.deepEqual(framesOf(close, "working").frames.map(list), [[2, 2, 3, 1], [0, 0, 0, 1]]);
    const one = replacePalette(data, ["#0000ff"]);
    assert.deepEqual(framesOf(one, "idle").frames.map(list), [[1, 1, 1, 0]]);
  });
});

describe("a picture becoming pixels", () => {
  const px = (...pixels: [number, number, number, number][]): Uint8ClampedArray => Uint8ClampedArray.from(pixels.flat());

  it("keeps a two colour picture as two colours, most common first", () => {
    const image = px([255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 255, 255]);
    const out = quantize(image, 3, 1, { maxColours: 8 });
    assert.deepEqual(out.palette, ["#ff0000", "#0000ff"]);
    assert.deepEqual(list(out.frame), [1, 1, 2]);
  });

  it("makes faint pixels clear at the alpha cutoff", () => {
    const image = px([255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 255, 100]);
    assert.deepEqual(list(quantize(image, 3, 1, { maxColours: 8 }).frame), [1, 1, 0]);
    assert.deepEqual(quantize(image, 3, 1, { maxColours: 8 }).palette, ["#ff0000"]);
    assert.deepEqual(list(quantize(image, 3, 1, { maxColours: 8, alphaCutoff: 50 }).frame), [1, 1, 2]);
    assert.deepEqual(quantize(px([0, 0, 0, 0]), 1, 1, { maxColours: 4 }), { palette: [], frame: bytes(0) }, "a clear picture has no colours");
  });

  it("maps to a seed palette when given one, and never adds to it", () => {
    const image = px([250, 0, 0, 255], [0, 0, 250, 255], [0, 0, 0, 0]);
    const out = quantize(image, 3, 1, { maxColours: 8, seedPalette: ["#0000FF", "#ff0000"] });
    assert.deepEqual(out.palette, ["#0000ff", "#ff0000"]);
    assert.deepEqual(list(out.frame), [2, 1, 0]);
  });

  it("reduces many colours to the number asked, the same way every time", () => {
    const greys = Uint8ClampedArray.from(Array.from({ length: 16 }, (_, i) => [i * 16, i * 16, i * 16, 255]).flat());
    const two = quantize(greys, 16, 1, { maxColours: 2 });
    assert.equal(two.palette.length, 2);
    assert.ok(list(two.frame).every((c) => c === 1 || c === 2));
    assert.ok(list(two.frame).slice(0, 8).every((c, _, all) => c === all[0]) && list(two.frame).slice(8).every((c, _, all) => c === all[0]), "dark on one side, light on the other");
    assert.deepEqual(quantize(greys, 16, 1, { maxColours: 2 }), two);
    const five = quantize(greys, 16, 1, { maxColours: 5 });
    assert.equal(five.palette.length, 5);
    assert.equal(quantize(greys, 16, 1, { maxColours: 1 }).palette.length, 2, "fewer than two is two");
    assert.equal(new Set(five.palette).size, 5, "no colour twice");
  });

  it("shrinks a picture by averaging what each cell covers, or by picking the nearest pixel", () => {
    const check = px([0, 0, 0, 255], [255, 255, 255, 255], [255, 255, 255, 255], [0, 0, 0, 255]);
    assert.deepEqual([...resample(check, 2, 2, 1, 1, "box")], [128, 128, 128, 255]);
    assert.deepEqual([...resample(check, 2, 2, 1, 1, "nearest")], [0, 0, 0, 255], "the pixel under the centre of the cell");
    const half = px([255, 0, 0, 255], [0, 255, 0, 0]);
    assert.deepEqual([...resample(half, 2, 1, 1, 1, "box")], [255, 0, 0, 128], "a clear pixel lends no colour, only its absence");
    assert.deepEqual([...resample(px([0, 0, 0, 0], [0, 0, 0, 0]), 2, 1, 1, 1, "box")], [0, 0, 0, 0]);
    assert.deepEqual([...resample(px([10, 20, 30, 255]), 1, 1, 2, 2, "box")], [10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255], "growing repeats");
  });

  it("fits a picture into the grid keeping its shape, centred", () => {
    assert.deepEqual(fitInto(100, 50, 16, 16), { x: 0, y: 4, w: 16, h: 8 });
    assert.deepEqual(fitInto(50, 100, 16, 16), { x: 4, y: 0, w: 8, h: 16 });
    assert.deepEqual(fitInto(16, 16, 16, 16), { x: 0, y: 0, w: 16, h: 16 });
    assert.deepEqual(fitInto(1000, 1, 16, 16), { x: 0, y: 7, w: 16, h: 1 }, "never thinner than a cell");
    assert.deepEqual(fitInto(3, 3, 32, 32), { x: 0, y: 0, w: 32, h: 32 }, "a small picture grows to fill");
  });
});

describe("rendering a frame", () => {
  it("merges each row's runs into one path per colour and skips clear cells", () => {
    const frame = bytes(1, 1, 0, 2, 1, 1);
    assert.deepEqual(pixelPaths(["#ff0000", "#00ff00"], frame, 3, 2), [
      { fill: "#ff0000", d: "M0 0h2v1h-2zM1 1h2v1h-2z" },
      { fill: "#00ff00", d: "M0 1h1v1h-1z" },
    ]);
    assert.deepEqual(pixelPaths(["#ff0000"], bytes(0, 0, 0, 0), 2, 2), []);
    assert.deepEqual(pixelPaths(["#ff0000"], bytes(1, 5), 2, 1), [{ fill: "#ff0000", d: "M0 0h1v1h-1z" }], "a colour the palette lacks draws nothing");
  });

  it("turns a frame into RGBA bytes for a canvas", () => {
    assert.deepEqual([...frameToRgba(["#102030"], bytes(1, 0), 2, 1)], [16, 32, 48, 255, 0, 0, 0, 0]);
    assert.deepEqual([...frameToRgba([], bytes(3), 1, 1)], [0, 0, 0, 0]);
  });
});

describe("what the server will and will not keep", () => {
  const frame8 = packFrame(emptyFrame(8, 8));
  const good = (): Record<string, unknown> => ({ w: 8, h: 8, palette: ["#FF0000"], moods: { idle: { ms: 400, frames: [frame8] } } });
  const refused = (raw: unknown, pattern: RegExp, why: string): void => {
    const result = validatePixelData(raw);
    assert.equal(result.ok, false, why);
    if (!result.ok) assert.match(result.error, pattern, why);
  };

  it("accepts a good value and returns it in canonical form", () => {
    const result = validatePixelData(good());
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.data, { w: 8, h: 8, palette: ["#ff0000"], moods: { idle: { ms: 400, frames: [frame8] } } });
    }
    refused(sample(), /^w must be a whole number from 8 to 64/, "the tiny fixture used above is below the contract's smallest side");
    assert.ok(validatePixelData(blankPixelData(64, "pico")).ok);
    const many = { ...good(), moods: { idle: { ms: 400, frames: new Array(MAX_FRAMES_PER_MOOD).fill(frame8) }, working: { ms: 40, frames: new Array(8).fill(frame8) }, attention: { ms: 2000, frames: new Array(8).fill(frame8) }, asleep: { ms: 400, frames: new Array(8).fill(frame8) } } };
    assert.ok(validatePixelData(many).ok, `${MAX_TOTAL_FRAMES} frames in all is allowed`);
  });

  it("names the field that breaks each rule", () => {
    refused(null, /must be an object/, "not an object");
    refused([], /must be an object/, "a list is not an object");
    refused({ ...good(), w: 7 }, /^w must be a whole number from 8 to 64/, "too narrow");
    refused({ ...good(), h: 65 }, /^h must be/, "too tall");
    refused({ ...good(), w: 8.5 }, /^w must be a whole number/, "not whole");
    refused({ ...good(), palette: "red" }, /^palette must be a list/, "palette not a list");
    refused({ ...good(), palette: new Array(MAX_PALETTE + 1).fill("#000000") }, /^palette may hold at most 32/, "too many colours");
    refused({ ...good(), palette: ["#000000", "red"] }, /^palette\[1\] is not a #rrggbb colour/, "not a colour");
    refused({ ...good(), palette: ["#abc"] }, /^palette\[0\]/, "short hex");
    refused({ ...good(), moods: [] }, /^moods must be an object/, "moods not an object");
    refused({ ...good(), moods: { idle: { ms: 400, frames: [frame8] }, happy: { ms: 400, frames: [frame8] } } }, /unknown mood: happy/, "unknown mood");
    refused({ ...good(), moods: { working: { ms: 400, frames: [frame8] } } }, /^moods\.idle is required/, "no resting frames");
    refused({ ...good(), moods: { idle: "x" } }, /^moods\.idle must be an object/, "mood not an object");
    refused({ ...good(), moods: { idle: { ms: 30, frames: [frame8] } } }, /^moods\.idle\.ms must be a whole number from 40 to 2000/, "too fast");
    refused({ ...good(), moods: { idle: { ms: 2001, frames: [frame8] } } }, /^moods\.idle\.ms/, "too slow");
    refused({ ...good(), moods: { idle: { ms: 100.5, frames: [frame8] } } }, /^moods\.idle\.ms/, "not whole");
    refused({ ...good(), moods: { idle: { ms: 400, frames: [] } } }, /^moods\.idle\.frames must hold 1 to 8 frames/, "no frames");
    refused({ ...good(), moods: { idle: { ms: 400, frames: new Array(9).fill(frame8) } } }, /^moods\.idle\.frames must hold 1 to 8/, "too many frames");
    refused({ ...good(), moods: { idle: { ms: 400, frames: ["not base64!"] } } }, /^moods\.idle\.frames\[0\] is not a valid frame of 64 cells/, "not base64");
    refused({ ...good(), moods: { idle: { ms: 400, frames: [packFrame(emptyFrame(8, 7))] } } }, /^moods\.idle\.frames\[0\] is not a valid frame/, "wrong size");
    refused({ ...good(), moods: { idle: { ms: 400, frames: [frame8.slice(0, -2) + "B="] } } }, /^moods\.idle\.frames\[0\] is not a valid frame/, "not canonical");
    refused({ ...good(), moods: { idle: { ms: 400, frames: [frame8, 5] } } }, /^moods\.idle\.frames\[1\]/, "a frame that is not a string");
    const painted = emptyFrame(8, 8);
    painted[3] = 2;
    refused({ ...good(), moods: { idle: { ms: 400, frames: [packFrame(painted)] } } }, /^moods\.idle\.frames\[0\] uses a colour the palette does not have/, "colour past the palette");
    const eight = new Array(8).fill(frame8);
    refused({ ...good(), moods: { idle: { ms: 400, frames: eight }, working: { ms: 400, frames: eight }, attention: { ms: 400, frames: eight }, delight: { ms: 400, frames: eight }, concern: { ms: 400, frames: [frame8] } } }, /^moods hold 33 frames in all; the most is 32/, "too many in all");
  });

  it("says what a drawing is in one line, and how big it is", () => {
    assert.equal(describePixel(sample()), "2 by 2 pixel art, 3 colours, 2 moods with their own frames");
    assert.equal(describePixel({ ...blankPixelData(16), palette: ["#000000"] }), "16 by 16 pixel art, 1 colour, 1 mood with its own frames");
    const data = sample();
    assert.equal(pixelBytes(data), JSON.stringify(data).length);
    assert.ok(pixelBytes(blankPixelData(64)) > 5000);
  });

  it("holds the constants the studio and the server agree on", () => {
    assert.deepEqual(PIXEL_MOODS, ["idle", "working", "attention", "delight", "concern", "asleep"]);
    assert.deepEqual(Object.values(PIXEL_MOOD_LABELS), ["Resting", "Working", "Needs you", "Pleased", "Concerned", "Asleep"]);
    assert.deepEqual(PIXEL_SIZES, [16, 24, 32, 48, 64]);
    for (const p of PALETTES) {
      assert.ok(p.colours.length >= 2 && p.colours.length <= MAX_PALETTE, p.name);
      assert.ok(p.colours.every((c) => /^#[0-9a-f]{6}$/.test(c)), `${p.name} is lower case #rrggbb`);
      assert.equal(new Set(p.colours).size, p.colours.length, `${p.name} has no colour twice`);
    }
    assert.deepEqual(PALETTES.map((p) => p.name), ["Ancilla", "Pico", "Gameboy", "Pastel", "Mono"]);
  });
});

describe("the sprite in the avatar's box", () => {
  const data: PixelData = { w: 16, h: 16, palette: ["#ff0000", "#00ff00"], moods: { idle: { ms: 400, frames: [packFrame(stamp(emptyFrame(16, 16), 16, 16, [[0, 0], [1, 0]], 1))] }, working: { ms: 100, frames: [packFrame(stamp(emptyFrame(16, 16), 16, 16, [[5, 5]], 2)), packFrame(stamp(emptyFrame(16, 16), 16, 16, [[6, 6]], 1))] } } };
  const render = (mood: AvatarMoodId, paused?: boolean) => renderToStaticMarkup(createElement("svg", { viewBox: "0 0 160 160" }, createElement(PixelSprite, { data, mood, paused })));

  it("centres the art on the floor of a 120 by 120 box", () => {
    assert.deepEqual(spriteTransform(16, 16), { x: 20, y: 24, scale: 7.5 });
    assert.deepEqual(spriteTransform(16, 8), { x: 20, y: 84, scale: 7.5 });
    assert.deepEqual(spriteTransform(32, 64), { x: 50, y: 24, scale: 1.875 });
  });

  it("renders one crisp path per colour inside the sprite group", () => {
    const markup = render("idle");
    assert.match(markup, /<g class="av-sprite"><g transform="translate\(20 24\) scale\(7\.5\)"><path d="M0 0h2v1h-2z" fill="#ff0000" shape-rendering="crispEdges"><\/path><\/g><\/g>/);
    const worn = render("asleep");
    assert.equal(worn, markup, "a mood without frames wears the resting ones");
  });

  it("shows the first frame of a mood's own frames, paused or not, until it is on a page", () => {
    assert.match(render("working"), /fill="#00ff00"/);
    assert.doesNotMatch(render("working"), /fill="#ff0000"/);
    assert.match(render("working", true), /fill="#00ff00"/);
  });
});

describe("what the studio does with a stroke and a frame", () => {
  const snapOf = (data: PixelData, mood: EditorSnapshot["mood"] = "idle", frame = 0): EditorSnapshot => ({ data, mood, frame });

  it("joins the cells a fast pointer skips, and redraws a shape from where it began", () => {
    const base = emptyFrame(4, 1);
    let stroke = startStroke({ tool: "pencil", w: 4, h: 1, colour: 1, mirror: "none", filled: false, wrap: true, base, at: [0, 0] });
    assert.deepEqual(list(stroke.work), [1, 0, 0, 0]);
    stroke = continueStroke(stroke, [3, 0]);
    assert.deepEqual(list(stroke.work), [1, 1, 1, 1]);
    assert.deepEqual(list(base), [0, 0, 0, 0]);
    const eraser = startStroke({ tool: "eraser", w: 4, h: 1, colour: 1, mirror: "none", filled: false, wrap: true, base: stroke.work, at: [1, 0] });
    assert.deepEqual(list(eraser.work), [1, 0, 1, 1]);
    let rect = startStroke({ tool: "rect", w: 4, h: 4, colour: 2, mirror: "none", filled: false, wrap: true, base: emptyFrame(4, 4), at: [0, 0] });
    rect = continueStroke(rect, [3, 3]);
    rect = continueStroke(rect, [1, 1]);
    assert.deepEqual(list(rect.work), [2, 2, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "the rectangle follows the pointer, not its history");
    const filled = startStroke({ tool: "fill", w: 3, h: 2, colour: 3, mirror: "h", filled: false, wrap: true, base: bytes(0, 1, 0, 0, 1, 0), at: [0, 0] });
    assert.deepEqual(list(filled.work), [3, 1, 3, 3, 1, 3], "a fill lands at the mirrored seed too");
    const moved = continueStroke(startStroke({ tool: "move", w: 2, h: 1, colour: 1, mirror: "none", filled: false, wrap: false, base: bytes(1, 0), at: [0, 0] }), [1, 0]);
    assert.deepEqual(list(moved.work), [0, 1]);
    assert.deepEqual(list(shapeFrame("line", emptyFrame(3, 1), 3, 1, [0, 0], [2, 0], 1, false, "none")), [1, 1, 1]);
    assert.equal(strokeWord("pencil", 3), "Painted 3 cells");
    assert.equal(strokeWord("eraser", 1), "Cleared 1 cell");
    assert.equal(strokeWord("fill", 0), "Nothing changed");
    assert.equal(toolForKey("b"), "pencil");
    assert.equal(toolForKey("O"), "ellipse");
    assert.equal(toolForKey("q"), null);
    assert.equal(nextMirror("none"), "h");
    assert.equal(nextMirror("both"), "none");
  });

  it("gives a mood its own frames the first time it is drawn on, as a copy of the resting ones", () => {
    const data = { ...sample(), moods: { idle: { ms: 300, frames: [packFrame(bytes(1, 0, 0, 0)), packFrame(bytes(0, 1, 0, 0))] } } };
    const next = setFrame(snapOf(data, "delight", 1), 1, bytes(2, 2, 2, 2));
    assert.deepEqual(framesOf(next.data, "delight").frames.map(list), [[1, 0, 0, 0], [2, 2, 2, 2]]);
    assert.equal(next.data.moods.delight?.ms, 300);
    assert.deepEqual(framesOf(next.data, "idle").frames.map(list), [[1, 0, 0, 0], [0, 1, 0, 0]], "the resting frames are untouched");
    assert.equal(idleIsEmpty(data), false);
    assert.equal(idleIsEmpty(blankPixelData(8)), true);
  });

  it("adds, copies, deletes and reorders frames within the limits, and says why not", () => {
    const data = sample();
    const added = addFrame(snapOf(data), false) as EditorSnapshot;
    assert.equal(added.frame, 1);
    assert.deepEqual(framesOf(added.data, "idle").frames.map(list), [[1, 2, 3, 0], [0, 0, 0, 0]]);
    const copied = addFrame(snapOf(data, "working", 0), true) as EditorSnapshot;
    assert.deepEqual(framesOf(copied.data, "working").frames.map(list), [[3, 3, 2, 1], [3, 3, 2, 1], [0, 0, 0, 1]]);
    assert.equal(frameLimitReason(snapOf(data)), null);
    let eight = snapOf(data);
    for (let i = 0; i < 7; i++) eight = addFrame(eight, false) as EditorSnapshot;
    assert.equal(frameLimitReason(eight), "A mood has at most 8 frames");
    assert.equal(addFrame(eight, false), null);
    const crowded: PixelData = { ...data, moods: { idle: { ms: 400, frames: new Array(8).fill(packFrame(bytes(1, 0, 0, 0))) }, working: { ms: 400, frames: new Array(8).fill(packFrame(bytes(1, 0, 0, 0))) }, attention: { ms: 400, frames: new Array(8).fill(packFrame(bytes(1, 0, 0, 0))) }, delight: { ms: 400, frames: new Array(7).fill(packFrame(bytes(1, 0, 0, 0))) } } };
    assert.equal(frameLimitReason(snapOf(crowded, "delight")), null);
    assert.equal(frameLimitReason(snapOf(crowded, "concern")), "All moods together have at most 32 frames", "a mood that would copy eight resting frames cannot");
    assert.equal(copyRestingHere(snapOf(crowded, "concern")), null);
    assert.equal(deleteReason(snapOf(data, "asleep")), "This mood wears the resting frames");
    assert.equal(deleteReason(snapOf(data)), "The resting mood keeps at least one frame");
    assert.equal(deleteFrame(snapOf(data)), null);
    const fewer = deleteFrame(snapOf(data, "working", 0)) as EditorSnapshot;
    assert.deepEqual(framesOf(fewer.data, "working").frames.map(list), [[0, 0, 0, 1]]);
    const none = deleteFrame(fewer) as EditorSnapshot;
    assert.equal(none.data.moods.working, undefined, "the last frame gone, the mood wears the resting ones again");
    const swapped = moveFrame(snapOf(data, "working", 0), 1) as EditorSnapshot;
    assert.equal(swapped.frame, 1);
    assert.deepEqual(framesOf(swapped.data, "working").frames.map(list), [[0, 0, 0, 1], [3, 3, 2, 1]]);
    assert.equal(moveFrame(snapOf(data, "working", 1), 1), null);
    assert.equal(moveFrame(snapOf(data, "asleep"), 1), null);
    const copy = copyRestingHere(snapOf(data, "asleep")) as EditorSnapshot;
    assert.deepEqual(copy.data.moods.asleep, { ms: 400, frames: [packFrame(bytes(1, 2, 3, 0))] });
    assert.equal(copyRestingHere(snapOf(data, "working")), null, "a mood with its own frames keeps them");
    assert.equal(dropOwnFrames(snapOf(data, "working"))?.data.moods.working, undefined);
    assert.equal(dropOwnFrames(snapOf(data)), null, "the resting mood cannot drop its frames");
    assert.equal(setMs(snapOf(data, "working"), 5).data.moods.working?.ms, 40);
    assert.equal(setMs(snapOf(data, "working"), 9999).data.moods.working?.ms, 2000);
    assert.equal(setMs(snapOf(data, "asleep"), 100).data.moods.asleep, undefined, "timing belongs to a mood's own frames");
  });

  it("keeps a bounded history and tells the canvas apart for a screen reader", () => {
    let history = { past: [] as EditorSnapshot[], future: [snapOf(sample())] };
    for (let i = 0; i < 250; i++) history = pushHistory(history, snapOf(sample(), "idle", i));
    assert.equal(history.past.length, 200);
    assert.equal(history.past[0]?.frame, 50);
    assert.deepEqual(history.future, [], "a new step forgets what was undone");
    assert.equal(canvasLabel(snapOf(sample(), "working", 1), "pencil"), "Pixel canvas, 2 by 2 cells, Working, frame 2 of 2. Arrow keys move the cursor; Space or Enter uses the pencil.");
    assert.match(canvasLabel(snapOf(sample(), "asleep"), "fill"), /Asleep, wearing the resting frames/);
  });
});
