import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { COMPANIONS, companionById } from "../src/components/assistant/companion/companions/catalog.js";
import { SIGIL_FORMS, rng } from "../src/components/assistant/companion/faces.js";
import { DEFAULT_FIGURE, normalizeFigure } from "../src/components/assistant/companion/figure/parts.js";
import { LookEditor } from "../src/components/assistant/companion/edit.js";
import { BringTab } from "../src/components/assistant/companion/looks/Bring.js";
import { DrawTab } from "../src/components/assistant/companion/looks/Draw.js";
import { BuildTab, ChooseTab, surprise, type Draft } from "../src/components/assistant/companion/looks/LookStudio.js";
import { MineTab } from "../src/components/assistant/companion/looks/Mine.js";
import { AVATAR_FILE_FORMAT, MAX_AVATAR_FILE_BYTES, avatarFileName, bytesLabel, parseAvatarFile, toAvatarFile } from "../src/components/assistant/companion/looks/library.js";
import { unpackPetArchive } from "../src/components/assistant/companion/looks/pet-zip.js";
import { MAX_PICTURE_BYTES, MOOD_MS, SHEET_MOODS, cellHasArt, compactSheet, dataUrlBytes, fitScale, hasArt, petRows, planOf, rowFrames, sequentialRows, sheetOf, storedSize, suggestGrid, suggestGridFromPixels } from "../src/components/assistant/companion/looks/raster.js";
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
    assert.deepEqual(suggestGrid(1536, 2288), { cols: 8, rows: 11, atlas: true }, "v2 desktop-pet atlas with directional rows");
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

  it("lays the desktop-pet sheet out across v1 9-row, v2 11-row, and 6-row sheets", () => {
    const v1 = petRows([4, 6, 6, 5, 5, 3, 3, 6, 2]);
    assert.deepEqual(v1.map((p) => p.mood), ["idle", null, null, "delight", null, "concern", "attention", "working", "asleep"]);
    const v2 = petRows([4, 6, 6, 5, 5, 3, 3, 6, 2, 8, 8]);
    assert.deepEqual(v2.map((p) => p.mood), ["idle", null, null, "delight", null, "concern", "attention", "working", "asleep", null, null]);
    assert.deepEqual(petRows([4, 0, 6, 0, 5, 3]).map((p) => p.mood), ["idle", null, null, null, "attention", "concern"], "falls back to earlier rows when rows 6-8 are absent");
  });

  it("makes the sheet a plan describes, with a resting row whatever the plan says, and compacts unused rows", () => {
    const sheet = sheetOf(8, 11, petRows([4, 6, 6, 5, 5, 3, 3, 6, 2, 8, 8]));
    assert.equal(sheet.cols, 8);
    assert.equal(sheet.rows, 11);
    assert.deepEqual(sheet.moods.idle, { row: 0, frames: 4, ms: MOOD_MS.idle });
    assert.deepEqual(sheet.moods.delight, { row: 3, frames: 5, ms: MOOD_MS.delight });
    assert.deepEqual(sheet.moods.working, { row: 7, frames: 6, ms: MOOD_MS.working });
    assert.deepEqual(sheet.moods.asleep, { row: 8, frames: 2, ms: MOOD_MS.asleep });
    const compacted = compactSheet(sheet);
    assert.deepEqual(compacted.usedRows, [0, 3, 5, 6, 7, 8]);
    assert.equal(compacted.cols, 6);
    assert.equal(compacted.sheet.rows, 6);
    assert.deepEqual(compacted.sheet.moods.working, { row: 4, frames: 6, ms: MOOD_MS.working });
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

describe("unpacking a desktop-pet .zip archive", () => {
  const u16le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
  const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

  async function deflateRaw(input: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([input as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function makeZip(files: { name: string; data: Uint8Array; deflate?: boolean }[]): Promise<Uint8Array> {
    const enc = new TextEncoder();
    const locals: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const method = f.deflate ? 8 : 0;
      const body = f.deflate ? await deflateRaw(f.data) : f.data;
      const localHeader = new Uint8Array([
        0x50, 0x4b, 0x03, 0x04,
        ...u16le(20), ...u16le(0), ...u16le(method), ...u16le(0), ...u16le(0),
        ...u32le(0), ...u32le(body.byteLength), ...u32le(f.data.byteLength),
        ...u16le(nameBytes.byteLength), ...u16le(0),
      ]);
      locals.push(localHeader, nameBytes, body);
      const cdHeader = new Uint8Array([
        0x50, 0x4b, 0x01, 0x02,
        ...u16le(20), ...u16le(20), ...u16le(0), ...u16le(method), ...u16le(0), ...u16le(0),
        ...u32le(0), ...u32le(body.byteLength), ...u32le(f.data.byteLength),
        ...u16le(nameBytes.byteLength), ...u16le(0), ...u16le(0), ...u16le(0), ...u16le(0),
        ...u32le(0), ...u32le(offset),
      ]);
      central.push(cdHeader, nameBytes);
      offset += localHeader.byteLength + nameBytes.byteLength + body.byteLength;
    }
    const cdSize = central.reduce((s, b) => s + b.byteLength, 0);
    const eocd = new Uint8Array([
      0x50, 0x4b, 0x05, 0x06,
      ...u16le(0), ...u16le(0), ...u16le(files.length), ...u16le(files.length),
      ...u32le(cdSize), ...u32le(offset), ...u16le(0),
    ]);
    const total = offset + cdSize + eocd.byteLength;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of [...locals, ...central, eocd]) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }

  it("extracts pet.json displayName and deflated spritesheet.webp while ignoring macOS junk entries", async () => {
    const enc = new TextEncoder();
    const fakeWebp = enc.encode("RIFF\x10\x00\x00\x00WEBPVP8 ");
    const archive = await makeZip([
      { name: "__MACOSX/._spritesheet.webp", data: enc.encode("junk") },
      { name: "chassis-pet/pet.json", data: enc.encode(JSON.stringify({ id: "chassis", displayName: "GlaDOS Core", spritesheetPath: "spritesheet.webp", spriteVersionNumber: 2 })), deflate: true },
      { name: "chassis-pet/spritesheet.webp", data: fakeWebp, deflate: true },
    ]);
    const unpacked = await unpackPetArchive(archive, "chassis-pet.zip");
    assert.equal(unpacked.title, "GlaDOS Core");
    assert.equal(unpacked.desktopPet, true);
    assert.equal(unpacked.file.name, "spritesheet.webp");
    assert.equal(unpacked.file.type, "image/webp");
    assert.deepEqual(new Uint8Array(await unpacked.file.arrayBuffer()), fakeWebp);
  });

  it("rejects archives without pictures or corrupt buffers", async () => {
    const enc = new TextEncoder();
    const noImg = await makeZip([{ name: "readme.txt", data: enc.encode("hello") }]);
    await assert.rejects(() => unpackPetArchive(noImg, "empty.zip"), /No PNG, WebP/);
    await assert.rejects(() => unpackPetArchive(enc.encode("not a zip at all"), "bad.zip"), /ZIP/);
  });
});

describe("a surprise", () => {
  it("picks from studio companions and geometric sigils, never low-quality blob figures", () => {
    const random = rng(2024);
    let companions = 0;
    let sigils = 0;
    for (let i = 0; i < 200; i += 1) {
      const s = surprise(random);
      assert.ok(s.look, "it says what it wears");
      if (s.look?.kind === "companion") {
        companions += 1;
        assert.ok(companionById(s.look.id), `known studio companion ${s.look.id}`);
        assert.ok((s.hue ?? 0) >= 0 && (s.hue ?? 0) <= 359);
      } else if (s.look?.kind === "sigil") {
        sigils += 1;
        assert.ok(SIGIL_FORMS.some((f) => f.form === s.form), `geometric sigil ${String(s.form)}`);
      } else assert.fail(`unexpected surprise look: ${String(s.look?.kind)}`);
    }
    assert.ok(companions > 120 && sigils > 10, "mostly studio companions, with geometric sigils alongside");
  });
});

describe("choosing a look", () => {
  const noop = () => undefined;

  it("offers the studio companions and minimal geometric sigils, without cartoon presets", () => {
    const sigil = inApp(createElement(ChooseTab, { draft: CHARACTER, onChange: noop }));
    for (const c of COMPANIONS) assert.ok(text(sigil).includes(c.name), `${c.name} is on offer`);
    for (const name of ["Halo", "Optic", "Cipher"]) assert.ok(text(sigil).includes(name), `${name} is on offer`);
    for (const removed of ["Tabby", "Bunny", "Slime", "Dragonling", "Critter", "Hologram"]) {
      assert.ok(!text(sigil).includes(removed), `${removed} low-quality preset was removed`);
    }
    assert.ok(/aria-label="Optic" aria-pressed="true"/.test(sigil) || /aria-pressed="true"[^>]*aria-label="Optic"/.test(sigil), "the form it wears is marked");
    assert.ok(text(sigil).includes("Lens"), "a form of light has its variants");
    const vesper = companionById("vesper")!;
    const worn = inApp(createElement(ChooseTab, { draft: wearing({ kind: "companion", id: "vesper" }, { hue: vesper.hue, glow: vesper.glow }), onChange: noop }));
    assert.ok(/aria-label="Vesper" aria-pressed="true"/.test(worn) || /aria-pressed="true"[^>]*aria-label="Vesper"/.test(worn), "the studio companion it wears is marked");
    assert.ok(!text(worn).includes("Lens"), "a companion has no lens blades selector");
    assert.ok(text(worn).includes("Stage and aura light") && text(worn).includes("Signature"), "companion stage and aura light can be tuned or reset");
  });

  it("keeps legacy saved figures editable from Mine while keeping Build out of the main tab bar", () => {
    const start = inApp(createElement(BuildTab, { draft: CHARACTER, onChange: noop, saveable: true }));
    assert.ok(text(start).includes("Start with a plain figure"), "a form of light has no parts yet");
    const build = inApp(createElement(BuildTab, { draft: wearing({ kind: "figure", figure: { ...DEFAULT_FIGURE, body: "ghost" } }), onChange: noop, saveable: true }));
    for (const slot of ["Body", "On top", "Eyes", "Mouth", "Markings", "Wearing", "Around it", "Finish", "Colour"]) assert.ok(text(build).includes(slot), `${slot} can be changed`);
    const kept: AvatarPackView = { id: "av_9", name: "Bruno", kind: "figure", bytes: 10, createdAt: 1, updatedAt: 2, data: { figure: DEFAULT_FIGURE, hue: 40, glow: 70 } };
    const changing = text(inApp(createElement(BuildTab, { draft: wearing({ kind: "figure", figure: DEFAULT_FIGURE }), onChange: noop, saveable: true, editing: kept })));
    assert.ok(changing.includes("You are changing Bruno"));
    assert.ok(changing.includes("Save changes") && changing.includes("Save as new"));
  });

  it("shows companions directly in first-run mode and the four clean studio tabs on the Persona page", () => {
    const lite = inApp(createElement(LookEditor, { draft: CHARACTER, onChange: noop }));
    assert.ok(text(lite).includes("Vesper") && text(lite).includes("Orbital Core"));
    assert.ok(!text(lite).includes("Bring your own") && !text(lite).includes("Mine") && !text(lite).includes("Put one together from parts"));
    const full = inApp(createElement(LookEditor, { draft: CHARACTER, onChange: noop, full: true, name: "Vesper" }));
    for (const tab of ["Choose", "Bring your own", "Draw", "Mine"]) assert.ok(text(full).includes(tab), `${tab} is a tab`);
    assert.ok(!text(full).includes("Put one together from parts"));
    assert.ok(full.includes('role="tablist"') && full.includes('role="tab"'));
  });

  it("starts the other tabs without a server to ask", () => {
    const draft = wearing({ kind: "pack", id: "av_1", rev: 3 });
    assert.ok(text(inApp(createElement(DrawTab, { draft, name: "Vesper", edit: null, onWear: noop, onDone: noop }))).includes("New drawing"));
    assert.ok(text(inApp(createElement(BringTab, { draft, name: "Vesper", onWear: noop, onDone: noop }))).includes("Choose a file"));
    assert.ok(text(inApp(createElement(MineTab, { draft, name: "Vesper", onWear: noop, onEdit: noop }))).includes("Import an avatar file"));
  });
});
