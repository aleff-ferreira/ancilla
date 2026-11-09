import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { rng } from "../src/components/assistant/companion/faces.js";
import { DEFAULT_FIGURE, normalizeFigure } from "../src/components/assistant/companion/figure/parts.js";
import { presetById } from "../src/components/assistant/companion/figure/presets.js";
import { LookEditor } from "../src/components/assistant/companion/edit.js";
import { BringTab } from "../src/components/assistant/companion/looks/Bring.js";
import { DrawTab } from "../src/components/assistant/companion/looks/Draw.js";
import { BuildTab, ChooseTab, surprise, type Draft } from "../src/components/assistant/companion/looks/LookStudio.js";
import { MineTab } from "../src/components/assistant/companion/looks/Mine.js";
import { AVATAR_FILE_FORMAT, MAX_AVATAR_FILE_BYTES, avatarFileName, bytesLabel, parseAvatarFile, toAvatarFile } from "../src/components/assistant/companion/looks/library.js";
import { MAX_PICTURE_BYTES, MOOD_MS, SHEET_MOODS, cellHasArt, dataUrlBytes, fitScale, hasArt, petRows, planOf, rowFrames, sequentialRows, sheetOf, storedSize, suggestGrid, suggestGridFromPixels } from "../src/components/assistant/companion/looks/raster.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { Store, type AppState } from "../src/model/store.js";
import type { AssistantCharacterView, AvatarPackView } from "../src/types.js";
import { appState } from "./crew-fixtures.js";

const CHARACTER: AssistantCharacterView = {
  avatar: { form: "optic", hue: 195, glow: 60, detail: 1, seed: 7 },
  voice: { archetype: "steady", warmth: 2, humor: 1, directness: 3, curiosity: 1, formality: 1 },
  callsUser: "",
  quirks: [],
  presence: "tone",
  showBond: true,
  setupAt: 1,
};
const wearing = (look: NonNullable<Draft["avatar"]["look"]>, extra: Partial<Draft["avatar"]> = {}): Draft => ({ ...CHARACTER, avatar: { ...CHARACTER.avatar, look, ...extra } });

function inApp(element: ReturnType<typeof createElement>): string {
  const store = new Store<AppState>(appState());
  const controller = { store, assistant: async () => ({}) } as unknown as AncillaController;
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: element }) }));
}

const text = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** A sheet of `cols` by `rows` cells of `cw` by `ch`, clear except for one solid pixel in each cell named. */
function sheetPixels(cols: number, rows: number, cw: number, ch: number, cells: [number, number][]): Uint8ClampedArray {
  const w = cols * cw;
  const out = new Uint8ClampedArray(w * rows * ch * 4);
  for (const [c, r] of cells) out[((r * ch + Math.floor(ch / 2)) * w + c * cw + Math.floor(cw / 2)) * 4 + 3] = 255;
  return out;
}

/** A sheet of `cols` by `rows` cells of `cw` by `ch`, with a solid square of `size` pixels in the middle of each cell. */
function blockSheet(cols: number, rows: number, cw: number, ch: number, size: number): Uint8ClampedArray {
  const w = cols * cw;
  const out = new Uint8ClampedArray(w * rows * ch * 4);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      for (let y = 0; y < Math.min(size, ch); y += 1) {
        for (let x = 0; x < Math.min(size, cw); x += 1) out[((r * ch + Math.floor((ch - Math.min(size, ch)) / 2) + y) * w + c * cw + Math.floor((cw - Math.min(size, cw)) / 2) + x) * 4 + 3] = 255;
      }
    }
  }
  return out;
}

describe("reading a sprite sheet", () => {
  it("knows which cells have something in them", () => {
    const px = sheetPixels(4, 2, 10, 10, [[1, 0]]);
    assert.equal(cellHasArt(px, 40, 10, 0, 10, 10), true);
    assert.equal(cellHasArt(px, 40, 0, 0, 10, 10), false);
    assert.equal(cellHasArt(px, 40, 10, 10, 10, 10), false, "the cell below it is clear");
  });

  it("does not count the faintest haze as a drawing", () => {
    const px = new Uint8ClampedArray(10 * 10 * 4);
    px[3] = 8;
    assert.equal(cellHasArt(px, 10, 0, 0, 10, 10), false);
    px[3] = 40;
    assert.equal(cellHasArt(px, 10, 0, 0, 10, 10), true);
  });

  it("counts a row's frames up to its last occupied cell, and none for a row with nothing in it", () => {
    const px = sheetPixels(4, 3, 10, 10, [[0, 0], [1, 0], [3, 0], [0, 2]]);
    assert.deepEqual(rowFrames(px, 40, 30, 4, 3), [4, 0, 1], "a gap inside a row still counts: the animation plays through it");
  });

  it("guesses the grid of a sheet from its size, and says when it is sure", () => {
    assert.deepEqual(suggestGrid(1536, 1872), { cols: 8, rows: 9, atlas: true });
    assert.deepEqual(suggestGrid(512, 256), { cols: 2, rows: 1, atlas: false }, "a guess for the user to accept, not a promise");
    assert.deepEqual(suggestGrid(128, 128), { cols: 2, rows: 2, atlas: false });
    assert.equal(suggestGrid(100, 100), null, "no common cell size divides it");
    assert.equal(suggestGrid(192, 208), null, "one cell is a picture, not a sheet");
    assert.equal(suggestGrid(192 * 20, 208), null, "more columns than a sheet may have");
  });

  it("finds the grid in the pixels: the finest whose lines cross no drawing", () => {
    // Four by two cells of 64 pixels, a 20 pixel block in the middle of each: 128 would pass too, 64 is finer, 32 cuts a block.
    assert.deepEqual(suggestGridFromPixels(blockSheet(4, 2, 64, 64, 20), 256, 128), { cols: 4, rows: 2, atlas: false });
    assert.deepEqual(suggestGridFromPixels(blockSheet(2, 2, 96, 96, 30), 192, 192), { cols: 2, rows: 2, atlas: false });
    // One drawing across the middle of a picture has no grid, and a photograph (everything solid) has none either.
    assert.equal(suggestGridFromPixels(blockSheet(1, 1, 256, 128, 200), 256, 128), null);
    assert.equal(suggestGridFromPixels(new Uint8ClampedArray(256 * 128 * 4).fill(255), 256, 128), null);
    assert.equal(suggestGridFromPixels(new Uint8ClampedArray(100 * 100 * 4), 100, 100), null, "no common cell size divides it");
    // The desktop-pet cell size is believed on its size alone.
    assert.deepEqual(suggestGridFromPixels(new Uint8ClampedArray(1536 * 1872 * 4).fill(255), 1536, 1872), { cols: 8, rows: 9, atlas: true });
  });

  it("plays the rows that have something in them for the six moods, in order", () => {
    const plan = sequentialRows([4, 6, 5, 3, 2, 8, 9]);
    assert.deepEqual(plan.map((p) => p.mood), ["idle", "working", "attention", "delight", "concern", "asleep", null]);
    assert.deepEqual(plan.map((p) => p.frames), [4, 6, 5, 3, 2, 8, 9]);
    assert.equal(plan[0]?.ms, MOOD_MS.idle);
    const gaps = sequentialRows([0, 3, 0, 2]);
    assert.deepEqual(gaps.map((p) => p.mood), [null, "idle", null, "working"], "an empty row takes no mood, and the next row with art takes it");
  });

  it("lays the desktop-pet sheet out as well as it is known", () => {
    const plan = petRows([4, 6, 6, 5, 5, 3, 3, 6, 2]);
    assert.deepEqual(plan.map((p) => p.mood), ["idle", "working", null, "delight", "attention", "concern", null, null, null]);
    assert.deepEqual(petRows([4, 0, 6, 0, 5, 3]).map((p) => p.mood), ["idle", null, null, null, "attention", "concern"], "a row with nothing in it plays for nothing");
  });

  it("makes the sheet a plan describes, with a resting row whatever the plan says", () => {
    const sheet = sheetOf(8, 9, petRows([4, 6, 6, 5, 5, 3, 3, 6, 2]));
    assert.equal(sheet.cols, 8);
    assert.equal(sheet.rows, 9);
    assert.deepEqual(sheet.moods.idle, { row: 0, frames: 4, ms: MOOD_MS.idle });
    assert.deepEqual(sheet.moods.delight, { row: 3, frames: 5, ms: MOOD_MS.delight });
    assert.equal(sheet.moods.asleep, undefined);
    const none = sheetOf(4, 2, [{ mood: null, frames: 3, ms: 90 }, { mood: "working", frames: 2, ms: 90 }]);
    assert.deepEqual(none.moods.idle, { row: 0, frames: 3, ms: 90 }, "the first row rests when nothing else does");
    assert.deepEqual(none.moods.working, { row: 1, frames: 2, ms: 90 });
  });

  it("holds a plan's numbers inside what the server will take, and lets the first row for a mood win", () => {
    const sheet = sheetOf(3, 2, [{ mood: "idle", frames: 99, ms: 5 }, { mood: "idle", frames: 1, ms: 500 }, { mood: "working", frames: 1, ms: 99999 }]);
    assert.deepEqual(sheet.moods.idle, { row: 0, frames: 3, ms: 40 });
    assert.equal(sheet.moods.working, undefined, "row 3 does not exist in a sheet of two rows");
    const two = sheetOf(3, 3, [{ mood: "idle", frames: 1, ms: 200 }, { mood: "working", frames: 1, ms: 99999 }]);
    assert.deepEqual(two.moods.working, { row: 1, frames: 1, ms: 2000 });
  });

  it("leaves a row with nothing in it out, and rests on the first row that has something", () => {
    const sheet = sheetOf(3, 3, [{ mood: "idle", frames: 0, ms: 200 }, { mood: "working", frames: 0, ms: 100 }, { mood: "attention", frames: 2, ms: 100 }]);
    assert.equal(sheet.moods.working, undefined, "an empty row cannot play, even when it was given a mood");
    assert.deepEqual(sheet.moods.attention, { row: 2, frames: 2, ms: 100 });
    assert.deepEqual(sheet.moods.idle, { row: 2, frames: 2, ms: 100 }, "the first row with art rests");
    assert.equal(hasArt([{ mood: null, frames: 0, ms: 100 }]), false);
    assert.equal(hasArt([{ mood: null, frames: 0, ms: 100 }, { mood: null, frames: 1, ms: 100 }]), true);
  });

  it("reads a kept sheet back into the plan that made it", () => {
    const plan = petRows([4, 6, 6, 5, 5, 3, 3, 6, 2]);
    const back = planOf(sheetOf(8, 9, plan));
    for (const mood of SHEET_MOODS) {
      const was = plan.findIndex((p) => p.mood === mood);
      if (was >= 0) assert.deepEqual(back[was], plan[was]);
    }
    assert.equal(back.length, 9);
    assert.equal(back[2]?.mood, null);
  });
});

describe("shrinking a picture to what a face needs", () => {
  it("leaves a small picture alone", () => {
    assert.equal(fitScale(120, 120, 1, 1, 320, 1_200_000), 1);
  });

  it("shrinks a big cell, and a big sheet", () => {
    assert.equal(fitScale(1000, 500, 1, 1, 250, 5_000_000), 0.25, "by the cell");
    const scale = fitScale(1536, 1872, 8, 9, 192, 1_200_000);
    const size = storedSize(1536, 1872, 8, 9, scale);
    assert.ok(size.w * size.h <= 1_200_000 * 1.02, "by the total");
    assert.equal(size.w, size.cw * 8);
    assert.equal(size.h, size.ch * 9);
    assert.ok(size.cw >= 1 && size.ch >= 1);
  });

  it("stores whole cells, so that no frame bleeds into the next", () => {
    const size = storedSize(100, 60, 3, 2, 0.5);
    assert.deepEqual(size, { cw: 17, ch: 15, w: 51, h: 30 });
  });

  it("counts the bytes in a data URL", () => {
    assert.equal(dataUrlBytes("data:image/png;base64,AAAA"), 3);
    assert.equal(dataUrlBytes("data:image/png;base64,QQ=="), 1);
    assert.equal(dataUrlBytes("data:image/png;base64,QUI="), 2);
    assert.equal(dataUrlBytes("nonsense"), 0);
    assert.ok(MAX_PICTURE_BYTES < 520_000, "under what the server takes of one picture");
  });
});

describe("an avatar as a file", () => {
  const figureFile = (extra: Record<string, unknown> = {}) => JSON.stringify({ format: AVATAR_FILE_FORMAT, version: 1, name: "  Foxy  ", kind: "figure", data: { figure: DEFAULT_FIGURE, hue: 40, glow: 70 }, ...extra });

  it("is read back as it was written", () => {
    const pack: Pick<AvatarPackView, "name" | "kind" | "data"> = { name: "Foxy", kind: "figure", data: { figure: DEFAULT_FIGURE, hue: 40, glow: 70 } };
    const out = parseAvatarFile(JSON.stringify(toAvatarFile(pack)));
    assert.ok(out.ok);
    if (out.ok) assert.deepEqual(out.avatar, pack);
  });

  it("trims its name, names it when it has none, and makes a figure safe", () => {
    const out = parseAvatarFile(figureFile());
    assert.ok(out.ok);
    if (out.ok) assert.equal(out.avatar.name, "Foxy");
    const unnamed = parseAvatarFile(figureFile({ name: 7 }));
    assert.ok(unnamed.ok);
    if (unnamed.ok) assert.equal(unnamed.avatar.name, "Imported avatar");
    const odd = parseAvatarFile(figureFile({ data: { figure: { body: "nope", top: "cat" }, hue: 999, glow: -5 } }));
    assert.ok(odd.ok);
    if (odd.ok && odd.avatar.kind === "figure") {
      assert.deepEqual(odd.avatar.data.figure, normalizeFigure({ body: "nope", top: "cat" }));
      assert.equal(odd.avatar.data.hue, 359);
      assert.equal(odd.avatar.data.glow, 0);
    }
  });

  it("passes pixel art and pictures on for the server to check", () => {
    const data = { w: 8, h: 8, palette: ["#ffffff"], moods: {} };
    const out = parseAvatarFile(JSON.stringify({ format: AVATAR_FILE_FORMAT, version: 1, name: "Pip", kind: "pixel", data }));
    assert.ok(out.ok);
    if (out.ok) assert.deepEqual(out.avatar.data, data);
  });

  it("says in words what is wrong with a file that is not one", () => {
    const refused = (text: string) => {
      const out = parseAvatarFile(text);
      assert.equal(out.ok, false);
      return out.ok ? "" : out.error;
    };
    assert.match(refused("not json {"), /not readable as JSON/);
    assert.match(refused("[]"), /not an Ancilla avatar/);
    assert.match(refused(JSON.stringify({ format: "something.else", version: 1 })), /not an Ancilla avatar/);
    assert.match(refused(figureFile({ version: 2 })), /newer Ancilla/);
    assert.match(refused(figureFile({ kind: "hologram" })), /kind this Ancilla does not know/);
    assert.match(refused(figureFile({ data: "nothing" })), /no drawing/);
    assert.match(refused("x".repeat(MAX_AVATAR_FILE_BYTES + 1)), /too large/);
  });

  it("is named for what it is", () => {
    assert.equal(avatarFileName("My Fox!"), "my-fox.ancilla-avatar.json");
    assert.equal(avatarFileName("???"), "avatar.ancilla-avatar.json");
    assert.equal(avatarFileName("  Ünïcode Name  "), "n-code-name.ancilla-avatar.json");
    assert.ok(avatarFileName("a".repeat(200)).length < 70);
  });

  it("says how much room it takes", () => {
    assert.equal(bytesLabel(0), "0 B");
    assert.equal(bytesLabel(999), "999 B");
    assert.equal(bytesLabel(1500), "2 KB");
    assert.equal(bytesLabel(2_400_000), "2.4 MB");
  });
});

describe("a surprise", () => {
  it("is always something it can wear", () => {
    const random = rng(2024);
    let figures = 0;
    let sigils = 0;
    for (let i = 0; i < 200; i += 1) {
      const s = surprise(random);
      assert.ok(s.look, "it says what it wears");
      if (s.look?.kind === "figure") {
        figures += 1;
        assert.deepEqual(normalizeFigure(s.look.figure), s.look.figure);
        assert.ok((s.hue ?? 0) >= 0 && (s.hue ?? 0) <= 359);
      } else if (s.look?.kind === "sigil") sigils += 1;
      else assert.fail("a surprise never reaches for something that has to be fetched");
    }
    assert.ok(figures > 100 && sigils > 5, "mostly characters, now and then a form of light");
  });
});

describe("choosing a look", () => {
  const noop = () => undefined;

  it("offers the forms of light and the ready-made characters, and marks the one worn", () => {
    const sigil = inApp(createElement(ChooseTab, { draft: CHARACTER, onChange: noop }));
    for (const name of ["Halo", "Optic", "Hologram", "Critter", "Cipher", "Fox", "Robot", "Ghost", "Mage"]) assert.ok(text(sigil).includes(name), `${name} is on offer`);
    assert.ok(/aria-label="Optic" aria-pressed="true"/.test(sigil) || /aria-pressed="true"[^>]*aria-label="Optic"/.test(sigil), "the form it wears is marked");
    assert.ok(text(sigil).includes("Lens"), "a form of light has its variants");
    const fox = presetById("fox");
    assert.ok(fox);
    const worn = inApp(createElement(ChooseTab, { draft: wearing({ kind: "figure", figure: fox.figure }, { hue: fox.hue }), onChange: noop }));
    assert.ok(/aria-label="Fox" aria-pressed="true"/.test(worn) || /aria-pressed="true"[^>]*aria-label="Fox"/.test(worn), "the character it wears is marked");
    assert.ok(!text(worn).includes("Lens"), "a character has no lens to choose");
    assert.ok(worn.includes("Accent") && worn.includes("Shade"), "a figure's accent and shade can be changed");
  });

  it("builds a figure from its parts, one slot at a time", () => {
    const start = inApp(createElement(BuildTab, { draft: CHARACTER, onChange: noop, saveable: true }));
    assert.ok(text(start).includes("Start with a plain figure"), "a form of light has no parts yet");
    const build = inApp(createElement(BuildTab, { draft: wearing({ kind: "figure", figure: { ...DEFAULT_FIGURE, body: "ghost" } }), onChange: noop, saveable: true }));
    for (const slot of ["Body", "On top", "Eyes", "Mouth", "Markings", "Wearing", "Around it", "Finish", "Colour"]) assert.ok(text(build).includes(slot), `${slot} can be changed`);
    assert.ok(/aria-label="Body: Ghost" aria-pressed="true"/.test(build) || /aria-pressed="true"[^>]*aria-label="Body: Ghost"/.test(build), "the part in use is marked");
    assert.ok(text(build).includes("Keep this one"), "a figure can be kept");
    assert.ok(text(build).includes("It is a teal ghost figure with oval eyes"));
    assert.ok(!text(inApp(createElement(BuildTab, { draft: wearing({ kind: "figure", figure: DEFAULT_FIGURE }), onChange: noop, saveable: false }))).includes("Keep this one"), "without a library there is nothing to keep it in");
    const kept: AvatarPackView = { id: "av_9", name: "Bruno", kind: "figure", bytes: 10, createdAt: 1, updatedAt: 2, data: { figure: DEFAULT_FIGURE, hue: 40, glow: 70 } };
    const changing = text(inApp(createElement(BuildTab, { draft: wearing({ kind: "figure", figure: DEFAULT_FIGURE }), onChange: noop, saveable: true, editing: kept })));
    assert.ok(changing.includes("You are changing Bruno"), "a figure sent from Mine says whose it is");
    assert.ok(changing.includes("Save changes") && changing.includes("Save as new"), "and can be saved back into it or beside it");
    assert.ok(!changing.includes("Keep this one"));
  });

  it("offers a smaller choice where the server may not be reachable yet, and the whole of it on the Persona page", () => {
    const lite = inApp(createElement(LookEditor, { draft: CHARACTER, onChange: noop }));
    assert.ok(text(lite).includes("Choose") && text(lite).includes("Build"));
    assert.ok(!text(lite).includes("Bring your own") && !text(lite).includes("Mine"));
    const full = inApp(createElement(LookEditor, { draft: CHARACTER, onChange: noop, full: true, name: "Vesper" }));
    for (const tab of ["Choose", "Build", "Draw", "Bring your own", "Mine"]) assert.ok(text(full).includes(tab), `${tab} is a tab`);
    assert.ok(full.includes('role="tablist"') && full.includes('role="tab"'));
  });

  it("starts the other tabs without a server to ask", () => {
    const draft = wearing({ kind: "pack", id: "av_1", rev: 3 });
    assert.ok(text(inApp(createElement(DrawTab, { draft, name: "Vesper", edit: null, onWear: noop, onDone: noop }))).includes("New drawing"));
    assert.ok(text(inApp(createElement(BringTab, { draft, name: "Vesper", onWear: noop, onDone: noop }))).includes("Choose a file"));
    assert.ok(text(inApp(createElement(MineTab, { draft, name: "Vesper", onWear: noop, onEdit: noop }))).includes("Import an avatar file"));
  });
});
