/**
 * Saved avatars for the assistant: what is accepted (and refused, by field), how the library is kept, how the profile's
 * look follows the avatar it wears, and the HTTP surface, down to an assistant nobody has used yet.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { deflateSync } from "node:zlib";
import { MAX_AVATAR_BYTES, MAX_AVATARS, MAX_TOTAL_AVATAR_BYTES, parseAvatarInput } from "../src/assistant/avatars.js";
import { DEFAULT_CHARACTER, normalizeCharacter, ValidationError } from "../src/assistant/profile.js";
import { handleAssistant, type AssistantReply } from "../src/assistant/routes.js";
import { LATEST_VERSION, migrate, rollbackTo, schemaVersion } from "../src/assistant/schema.js";
import { AssistantService, type AssistantEvent } from "../src/assistant/service.js";
import { ConflictError, MemoryStore, NotFoundError } from "../src/assistant/store.js";
import type { AvatarPack, FigureSpec } from "../src/assistant/types.js";
import { FakeConnection, send, start } from "./harness.js";

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const MIN = 60_000;

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// ------------------------------------------------------------------------------------------------ fixtures, made in code

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A real PNG of `w` by `h` grey pixels. `padding` adds bytes to the image stream, for a picture of a chosen size. */
function png(w: number, h: number, padding = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((w + 1) * h, 0x80);
  for (let y = 0; y < h; y += 1) raw[y * (w + 1)] = 0; // filter byte per row
  const idat = padding > 0 ? Buffer.concat([deflateSync(raw), Buffer.alloc(padding, 7)]) : deflateSync(raw);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** The smallest JPEG shape: start of image, an APP0 segment, end of image. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

/** A RIFF container that says it holds WebP, with a VP8L chunk of a 1 by 1 picture. */
function webp(): Buffer {
  const vp8l = Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(vp8l.length);
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), Buffer.from("VP8L", "latin1"), size, vp8l]);
  const total = Buffer.alloc(4);
  total.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), total, body]);
}

const dataUrl = (type: "png" | "webp" | "jpeg", bytes: Buffer): string => `data:image/${type};base64,${bytes.toString("base64")}`;

const FIGURE: FigureSpec = { body: "round", top: "antenna", eyes: "dots", mouth: "smile", mark: "none", gear: "scarf", aura: "soft", finish: "matte", accent: null, shade: 2 };
const figureInput = (name = "Scout") => ({ name, kind: "figure", data: { figure: FIGURE, hue: 200, glow: 50 } });

const frame = (w: number, h: number, fill = 1): string => Buffer.alloc(w * h, fill).toString("base64");
const pixelInput = (name = "Blip") => ({ name, kind: "pixel", data: { w: 8, h: 8, palette: ["#FF0000", "#00ff00"], moods: { idle: { ms: 200, frames: [frame(8, 8), frame(8, 8, 2)] }, asleep: { ms: 800, frames: [frame(8, 8, 0)] } } } });
const imageInput = (name = "Photo", bytes: Buffer = png(2, 2), w = 2, h = 2, type: "png" | "webp" | "jpeg" = "png") => ({ name, kind: "image", data: { src: dataUrl(type, bytes), w, h, crisp: true } });

// ------------------------------------------------------------------------------------------------ rigs

interface Rig {
  store: MemoryStore;
  service: AssistantService;
  events: AssistantEvent[];
  clock: { t: number };
}

function rig(path = ":memory:"): Rig {
  const clock = { t: T0 };
  const events: AssistantEvent[] = [];
  const store = MemoryStore.open(path, { now: () => clock.t });
  const service = new AssistantService(store, { log: () => undefined, emit: (e) => events.push(e), now: () => clock.t });
  return { store, service, events, clock };
}

async function call(r: Rig, method: string, path: string, body: Record<string, unknown> = {}): Promise<AssistantReply> {
  const url = new URL(path, "http://localhost");
  const reply = await handleAssistant({ get: () => r.service, unavailable: () => null }, { method, path: url.pathname, query: url.searchParams, body: async () => body });
  assert.ok(reply, `${method} ${path} was not an assistant route`);
  return reply;
}

function refuses(input: unknown, field: string, message?: RegExp): void {
  assert.throws(
    () => parseAvatarInput(input),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError, `expected a ValidationError, got ${String(error)}`);
      assert.equal(error.field, field, `field for ${JSON.stringify(input).slice(0, 120)}: ${error.message}`);
      if (message) assert.match(error.message, message);
      return true;
    },
  );
}

const withData = (base: { name: string; kind: string; data: Record<string, unknown> }, data: Record<string, unknown>) => ({ ...base, data: { ...base.data, ...data } });
/** The figure less one of its fields. */
const without = (figure: FigureSpec, key: keyof FigureSpec): Record<string, unknown> => Object.fromEntries(Object.entries(figure).filter(([k]) => k !== key));

// ------------------------------------------------------------------------------------------------ validation

describe("what an avatar may be", () => {
  it("accepts a figure, pixel art and a picture of each type, and normalizes what it keeps", () => {
    const figure = parseAvatarInput(figureInput());
    assert.equal(figure.kind, "figure");
    assert.deepEqual(figure.data, { figure: FIGURE, hue: 200, glow: 50 });

    const pixel = parseAvatarInput(pixelInput());
    assert.equal(pixel.kind, "pixel");
    assert.deepEqual((pixel.data as { palette: string[] }).palette, ["#ff0000", "#00ff00"], "colours are kept in lower case");

    for (const [type, bytes] of [["png", png(2, 2)], ["webp", webp()], ["jpeg", JPEG]] as const) {
      const image = parseAvatarInput(imageInput("Pic", bytes, 2, 2, type));
      assert.equal(image.kind, "image");
      assert.equal((image.data as { src: string }).src, dataUrl(type, bytes));
    }
    const sheet = parseAvatarInput(withData(imageInput("Sheet", png(4, 2), 4, 2), { sheet: { cols: 2, rows: 2, moods: { idle: { row: 0, frames: 2, ms: 120 }, working: { row: 1, frames: 1, ms: 90 } } } }));
    assert.deepEqual((sheet.data as { sheet: unknown }).sheet, { cols: 2, rows: 2, moods: { idle: { row: 0, frames: 2, ms: 120 }, working: { row: 1, frames: 1, ms: 90 } } });
  });

  it("refuses unknown fields, a missing or wrong kind, and a name that is empty, too long or a credential", () => {
    refuses({ ...figureInput(), extra: 1 }, "body.extra", /unknown field/);
    refuses({ name: "x", data: {} }, "body.kind", /required/);
    refuses({ ...figureInput(), kind: "gif" }, "kind", /one of figure, pixel, image/);
    refuses({ ...figureInput(), name: "" }, "name", /needs a name/);
    refuses({ ...figureInput(), name: "   " }, "name", /needs a name/);
    refuses({ ...figureInput(), name: "n".repeat(41) }, "name", /longer than 40/);
    refuses({ ...figureInput(), name: 7 }, "name", /must be text/);
    refuses({ ...figureInput(), name: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, "name", /does not keep credentials/);
    assert.equal(parseAvatarInput({ ...figureInput(), name: "  Sc\u0007out  " }).name, "Scout", "control characters go, and so do the ends");
  });

  it("checks a figure's ten parts by shape, not by the catalogue", () => {
    const ok = parseAvatarInput(withData(figureInput(), { figure: { ...FIGURE, body: "part-from-a-newer-build", accent: 359 } }));
    assert.equal((ok.data as { figure: FigureSpec }).figure.body, "part-from-a-newer-build", "an id this server never heard of is kept");
    refuses(withData(figureInput(), { figure: { ...FIGURE, body: "Round" } }), "data.figure.body", /part id/);
    refuses(withData(figureInput(), { figure: { ...FIGURE, eyes: "-dash" } }), "data.figure.eyes");
    refuses(withData(figureInput(), { figure: { ...FIGURE, top: "x".repeat(25) } }), "data.figure.top");
    refuses(withData(figureInput(), { figure: { ...FIGURE, hat: "cap" } }), "data.figure.hat", /unknown field/);
    refuses(withData(figureInput(), { figure: without(FIGURE, "shade") }), "data.figure.shade", /required/);
    refuses(withData(figureInput(), { figure: { ...FIGURE, shade: 5 } }), "data.figure.shade", /between 0 and 4/);
    refuses(withData(figureInput(), { figure: { ...FIGURE, shade: 1.5 } }), "data.figure.shade", /whole number/);
    refuses(withData(figureInput(), { figure: { ...FIGURE, accent: 360 } }), "data.figure.accent");
    refuses(withData(figureInput(), { figure: { ...FIGURE, accent: "red" } }), "data.figure.accent");
    refuses(withData(figureInput(), { hue: 360 }), "data.hue");
    refuses(withData(figureInput(), { glow: -1 }), "data.glow");
    refuses(withData(figureInput(), { glitter: 1 }), "data.glitter", /unknown field/);
    refuses({ ...figureInput(), data: { figure: FIGURE, hue: 1 } }, "data.glow", /required/);
  });

  it("checks pixel art cell by cell: size, palette, moods, frame count, canonical base64, byte count and colour index", () => {
    refuses(withData(pixelInput(), { w: 7 }), "data.w", /between 8 and 64/);
    refuses(withData(pixelInput(), { h: 65 }), "data.h");
    refuses(withData(pixelInput(), { palette: [] }), "data.palette", /between 1 and 32/);
    refuses(withData(pixelInput(), { palette: new Array<string>(33).fill("#000000") }), "data.palette");
    refuses(withData(pixelInput(), { palette: ["red"] }), "data.palette[0]", /colour like/);
    refuses(withData(pixelInput(), { palette: ["#12345"] }), "data.palette[0]");
    refuses(withData(pixelInput(), { moods: { working: { ms: 100, frames: [frame(8, 8)] } } }), "data.moods.idle", /idle is required/);
    refuses(withData(pixelInput(), { moods: { idle: { ms: 100, frames: [frame(8, 8)] }, angry: { ms: 100, frames: [frame(8, 8)] } } }), "data.moods.angry", /not a mood/);
    refuses(withData(pixelInput(), { moods: { idle: { ms: 39, frames: [frame(8, 8)] } } }), "data.moods.idle.ms", /between 40 and 2000/);
    refuses(withData(pixelInput(), { moods: { idle: { ms: 100, frames: [] } } }), "data.moods.idle.frames", /1 to 8/);
    refuses(withData(pixelInput(), { moods: { idle: { ms: 100, frames: new Array<string>(9).fill(frame(8, 8)) } } }), "data.moods.idle.frames");
    refuses(withData(pixelInput(), { moods: { idle: { ms: 100, frames: [frame(8, 8)], loop: true } } }), "data.moods.idle.loop", /unknown field/);
    const eight = new Array<string>(8).fill(frame(8, 8));
    refuses(withData(pixelInput(), { moods: { idle: { ms: 100, frames: eight }, working: { ms: 100, frames: eight }, attention: { ms: 100, frames: eight }, delight: { ms: 100, frames: eight }, concern: { ms: 100, frames: [frame(8, 8)] } } }), "data.moods", /at most 32 frames/);
    assert.doesNotThrow(() => parseAvatarInput(withData(pixelInput(), { moods: { idle: { ms: 100, frames: eight }, working: { ms: 100, frames: eight }, attention: { ms: 100, frames: eight }, delight: { ms: 100, frames: eight } } })), "exactly 32 is fine");
    refuses(withData(pixelInput(), { moods: { idle: { ms: 100, frames: [frame(8, 7)] } } }), "data.moods.idle.frames[0]", /must hold 64 cells/);
    refuses(withData(pixelInput(), { moods: { idle: { ms: 100, frames: [frame(8, 8, 3)] } } }), "data.moods.idle.frames[0]", /colour 3, and the palette has 2/);
    refuses(withData(pixelInput(), { moods: { idle: { ms: 100, frames: [5] } } }), "data.moods.idle.frames[0]", /base64 text/);
    const canonical = frame(8, 8, 0);
    assert.ok(canonical.endsWith("A=="), "64 zero bytes end in a spare-bit character and two pads");
    const sloppy = `${canonical.slice(0, -3)}B==`;
    assert.deepEqual(Buffer.from(sloppy, "base64"), Buffer.from(canonical, "base64"), "the two decode alike, which is why the check is needed");
    refuses(withData(pixelInput(), { moods: { idle: { ms: 100, frames: [sloppy] } } }), "data.moods.idle.frames[0]", /canonical base64/);
    refuses(withData(pixelInput(), { moods: { idle: { ms: 100, frames: [`${canonical.slice(0, 10)} ${canonical.slice(10)}`] } } }), "data.moods.idle.frames[0]", /must be base64/);
    refuses(withData(pixelInput(), { moods: { idle: { ms: 100, frames: [canonical.replace(/\+|\//g, "-").slice(0, -2)] } } }), "data.moods.idle.frames[0]");
  });

  it("reads a picture's bytes: the data URL shape, the size, the magic of its type, and a PNG's own width and height", () => {
    refuses(withData(imageInput(), { src: "https://example.com/a.png" }), "data.src", /data URL/);
    refuses(withData(imageInput(), { src: `data:image/gif;base64,${png(1, 1).toString("base64")}` }), "data.src", /PNG, WebP or JPEG/);
    refuses(withData(imageInput(), { src: `data:image/png;base64,${png(1, 1).toString("base64")} ` }), "data.src");
    refuses(withData(imageInput(), { src: 12 }), "data.src", /must be text/);
    refuses(imageInput("Big", png(1, 1, 600_001), 1, 1), "data.src", /at most 600000/);
    refuses(imageInput("Fake", JPEG, 1, 1, "png"), "data.src", /says it is a PNG/);
    refuses(imageInput("Fake", png(1, 1), 1, 1, "jpeg"), "data.src", /says it is a JPEG/);
    refuses(imageInput("Fake", png(1, 1), 1, 1, "webp"), "data.src", /says it is a WEBP/);
    refuses(imageInput("Wrong size", png(2, 2), 1, 1), "data.w", /is 2 by 2, not 1 by 1/);
    refuses(imageInput("Wrong size", png(2, 2), 2, 3), "data.w");
    assert.doesNotThrow(() => parseAvatarInput(imageInput("Says so", JPEG, 300, 200, "jpeg")), "only a PNG carries its size where it can be read");
    refuses(imageInput("Zero", JPEG, 0, 1, "jpeg"), "data.w", /between 1 and 4096/);
    refuses(imageInput("Huge", JPEG, 4097, 1, "jpeg"), "data.w");
    refuses(withData(imageInput(), { crisp: "yes" }), "data.crisp", /true or false/);
    refuses({ ...imageInput(), data: { src: dataUrl("png", png(2, 2)), w: 2, h: 2 } }, "data.crisp", /required/);
    refuses(withData(imageInput(), { alt: "a face" }), "data.alt", /unknown field/);
    const sheetOf = (sheet: unknown) => withData(imageInput("Sheet", png(4, 2), 4, 2), { sheet });
    refuses(sheetOf({ cols: 2, rows: 2 }), "data.sheet.moods", /required/);
    refuses(sheetOf({ cols: 0, rows: 2, moods: { idle: { row: 0, frames: 1, ms: 100 } } }), "data.sheet.cols", /between 1 and 16/);
    refuses(sheetOf({ cols: 2, rows: 17, moods: { idle: { row: 0, frames: 1, ms: 100 } } }), "data.sheet.rows");
    refuses(sheetOf({ cols: 2, rows: 2, moods: { working: { row: 0, frames: 1, ms: 100 } } }), "data.sheet.moods.idle", /idle is required/);
    refuses(sheetOf({ cols: 2, rows: 2, moods: { idle: { row: 2, frames: 1, ms: 100 } } }), "data.sheet.moods.idle.row", /between 0 and 1/);
    refuses(sheetOf({ cols: 2, rows: 2, moods: { idle: { row: 0, frames: 3, ms: 100 } } }), "data.sheet.moods.idle.frames", /between 1 and 2/);
    refuses(sheetOf({ cols: 2, rows: 2, moods: { idle: { row: 0, frames: 1, ms: 2001 } } }), "data.sheet.moods.idle.ms");
    refuses(sheetOf({ cols: 2, rows: 2, moods: { idle: { row: 0, frames: 1, ms: 100, loop: 1 } } }), "data.sheet.moods.idle.loop", /unknown field/);
    refuses(sheetOf({ cols: 2, rows: 2, moods: { idle: { row: 0, frames: 1, ms: 100 } }, fps: 12 }), "data.sheet.fps", /unknown field/);
  });

  it("measures the data as JSON and refuses one over the ceiling, which a picture reaches before its own byte limit", () => {
    // 530 000 bytes of PNG become about 707 000 characters of base64: under the picture's own limit, over the JSON ceiling.
    refuses(imageInput("Large", png(1, 1, 530_000), 1, 1), "data", new RegExp(`at most ${MAX_AVATAR_BYTES}`));
    const fits = parseAvatarInput(imageInput("Fits", png(1, 1, 500_000), 1, 1));
    assert.ok(Buffer.byteLength(JSON.stringify(fits.data)) <= MAX_AVATAR_BYTES);
  });
});

// ------------------------------------------------------------------------------------------------ the store

describe("the avatar library", () => {
  it("creates, lists newest first, reads, renames, replaces data of the same kind, refuses a stale edit, and deletes", () => {
    const r = rig();
    const a = r.store.createAvatar(figureInput("First"));
    assert.match(a.id, /^av_[0-9a-f]{16}$/);
    assert.equal(a.createdAt, T0);
    assert.equal(a.bytes, Buffer.byteLength(JSON.stringify(a.data)));
    r.clock.t += MIN;
    const b = r.store.createAvatar(pixelInput("Second"));
    assert.deepEqual(r.store.listAvatars().map((m) => m.id), [b.id, a.id]);
    assert.equal("data" in (r.store.listAvatars()[0] as object), false, "the list carries no data");
    assert.deepEqual(r.store.getAvatar(a.id), a);
    assert.equal(r.store.getAvatar("av_nope"), null);
    assert.throws(() => r.store.requireAvatar("av_nope"), NotFoundError);
    assert.deepEqual(r.store.avatarUsage(), { used: a.bytes + b.bytes, total: 2 });

    r.clock.t += MIN;
    const renamed = r.store.updateAvatar(a.id, { name: "Renamed" }, undefined, a.updatedAt);
    assert.equal(renamed.name, "Renamed");
    assert.deepEqual(renamed.data, a.data, "the data stays when only the name changes");
    assert.equal(renamed.updatedAt, r.clock.t);
    assert.equal(r.store.listAvatars()[0]?.id, a.id, "a change brings it to the front");
    assert.throws(() => r.store.updateAvatar(a.id, { name: "Again" }, undefined, a.updatedAt), ConflictError);
    const replaced = r.store.updateAvatar(a.id, { data: { figure: { ...FIGURE, body: "tall" }, hue: 10, glow: 90 } });
    assert.equal((replaced.data as { hue: number }).hue, 10);
    assert.equal(replaced.name, "Renamed");
    assert.throws(() => r.store.updateAvatar(a.id, { data: pixelInput().data }), /data\.figure is required|unknown field data\.w/, "the kind cannot change: the data is read as the kind it has");
    assert.throws(() => r.store.updateAvatar(a.id, { kind: "pixel" }), /unknown field body\.kind/);
    assert.throws(() => r.store.updateAvatar(a.id, {}), /nothing to change/);
    assert.throws(() => r.store.updateAvatar("av_nope", { name: "x" }), NotFoundError);

    r.store.deleteAvatar(b.id);
    assert.deepEqual(r.store.listAvatars().map((m) => m.id), [a.id]);
    assert.throws(() => r.store.deleteAvatar(b.id), NotFoundError);
  });

  it("holds at most 24 avatars and 8 MB of data in all, and says which limit was hit", () => {
    const r = rig();
    for (let i = 0; i < MAX_AVATARS; i += 1) r.store.createAvatar(figureInput(`Figure ${i}`));
    assert.throws(() => r.store.createAvatar(figureInput("One more")), (e: unknown) => e instanceof ValidationError && e.field === "avatars" && /at most 24/.test(e.message));
    assert.equal(r.store.listAvatars().length, MAX_AVATARS);

    const heavy = rig();
    const big = imageInput("Big", png(1, 1, 510_000), 1, 1);
    const bigBytes = Buffer.byteLength(JSON.stringify(parseAvatarInput(big).data));
    while (heavy.store.avatarUsage().used + bigBytes <= MAX_TOTAL_AVATAR_BYTES) heavy.store.createAvatar(big);
    const count = heavy.store.listAvatars().length;
    assert.ok(count > 1 && count < MAX_AVATARS, `the byte limit comes first for pictures (${count} fit)`);
    assert.throws(() => heavy.store.createAvatar(big), (e: unknown) => e instanceof ValidationError && e.field === "data" && /past 8000000 bytes/.test(e.message));
    const small = heavy.store.createAvatar(figureInput("Small"));
    assert.ok(small.id, "a small one still fits");
    assert.throws(() => heavy.store.updateAvatar(small.id, { data: parseAvatarInput(big).data }), /unknown field data\.src/, "and cannot be turned into a picture");
    // One of the big ones, by name: the clock is held still here, so every avatar has the same time and the order of the list
    // among them is the order of their random ids, which may put the small one last.
    const first = heavy.store.listAvatars().find((a) => a.name === "Big") as { id: string };
    heavy.store.deleteAvatar(first.id);
    assert.ok(heavy.store.createAvatar(big).id, "removing one makes room again");
  });

  it("keeps the library across a reopen", async () => {
    const path = join(await temp("ancilla-avatars-store-"), "assistant.db");
    const a = rig(path);
    const made = a.store.createAvatar(pixelInput("Keeper"));
    a.store.saveProfile({ character: { avatar: { look: { kind: "pack", id: made.id } } } });
    a.store.close();
    const b = MemoryStore.open(path, { now: () => T0 + MIN });
    assert.deepEqual(b.getAvatar(made.id), made);
    assert.equal(b.listAvatars().length, 1);
    assert.deepEqual(b.getProfile().character.avatar.look, { kind: "pack", id: made.id, rev: made.updatedAt });
    b.close();
  });

  it("is schema step 6, which rolls back on its own and leaves the rest intact", () => {
    assert.equal(LATEST_VERSION, 6);
    const db = new DatabaseSync(":memory:");
    assert.equal(migrate(db), 6);
    const tables = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    assert.ok(tables().includes("avatar_packs"));
    assert.ok((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'avatar_packs_updated'").get() as unknown) !== undefined);
    db.exec("INSERT INTO assistant_profile (id, json, updated_at) VALUES ('default', '{}', 1)");
    db.exec("INSERT INTO avatar_packs (id, name, kind, data, bytes, created_at, updated_at) VALUES ('av_1', 'x', 'figure', '{}', 2, 1, 1)");
    assert.equal(rollbackTo(db, 5), 5);
    assert.equal(schemaVersion(db), 5);
    assert.equal(tables().includes("avatar_packs"), false);
    assert.ok(tables().includes("memory_vectors"), "step 5 is still there");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM assistant_profile").get() as { n: number }).n, 1, "and so is the profile");
    assert.equal(migrate(db), 6);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM avatar_packs").get() as { n: number }).n, 0);
    db.close();
  });
});

// ------------------------------------------------------------------------------------------------ the profile's look

describe("what the assistant wears", () => {
  it("is the sigil by default and whenever the stored look is malformed, and is otherwise kept as it is", () => {
    assert.deepEqual(DEFAULT_CHARACTER.avatar.look, { kind: "sigil" });
    const look = (raw: unknown) => normalizeCharacter({ avatar: { look: raw } }).avatar.look;
    assert.deepEqual(look(undefined), { kind: "sigil" });
    assert.deepEqual(look("figure"), { kind: "sigil" });
    assert.deepEqual(look({ kind: "dragon" }), { kind: "sigil" });
    assert.deepEqual(look({ kind: "sigil", extra: 1 }), { kind: "sigil" });
    assert.deepEqual(look({ kind: "companion", id: "vesper" }), { kind: "companion", id: "vesper" });
    assert.deepEqual(look({ kind: "companion", id: "future-companion-v2" }), { kind: "companion", id: "future-companion-v2" }, "an unknown companion id is kept: only its shape is checked");
    assert.deepEqual(look({ kind: "companion", id: "Bad_ID" }), { kind: "sigil" });
    assert.deepEqual(look({ kind: "companion" }), { kind: "sigil" });
    assert.deepEqual(look({ kind: "figure", figure: FIGURE }), { kind: "figure", figure: FIGURE });
    assert.deepEqual(look({ kind: "figure", figure: { ...FIGURE, body: "from-a-newer-ancilla" } }), { kind: "figure", figure: { ...FIGURE, body: "from-a-newer-ancilla" } }, "an unknown part id is kept: only its shape is checked");
    assert.deepEqual(look({ kind: "figure", figure: { ...FIGURE, body: "Round" } }), { kind: "sigil" });
    assert.deepEqual(look({ kind: "figure", figure: { ...FIGURE, hat: "cap" } }), { kind: "sigil" });
    assert.deepEqual(look({ kind: "figure", figure: without(FIGURE, "mark") }), { kind: "sigil" });
    assert.deepEqual(look({ kind: "figure", figure: { ...FIGURE, shade: 9 } }), { kind: "sigil" });
    assert.deepEqual(look({ kind: "figure", figure: { ...FIGURE, accent: 1.5 } }), { kind: "sigil" });
    assert.deepEqual(look({ kind: "pack", id: "av_0123456789abcdef", rev: 42 }), { kind: "pack", id: "av_0123456789abcdef", rev: 42 });
    assert.deepEqual(look({ kind: "pack", id: "av_0123456789abcdef" }), { kind: "pack", id: "av_0123456789abcdef", rev: 0 }, "a missing revision is zero");
    assert.deepEqual(look({ kind: "pack", id: "av_0123456789abcdef", rev: -1 }), { kind: "pack", id: "av_0123456789abcdef", rev: 0 });
    assert.deepEqual(look({ kind: "pack", id: "av_0123456789abcdef", rev: 1.5 }), { kind: "pack", id: "av_0123456789abcdef", rev: 0 });
    assert.deepEqual(look({ kind: "pack", id: "not an id!" }), { kind: "sigil" });
    assert.deepEqual(look({ kind: "pack", id: "x".repeat(65) }), { kind: "sigil" });
    assert.deepEqual(look({ kind: "pack" }), { kind: "sigil" });
  });

  it("is set through the profile, replaced whole while the other avatar fields still merge, and checked strictly", () => {
    const r = rig();
    const bad = (look: unknown, field: string, message?: RegExp) =>
      assert.throws(
        () => r.store.saveProfile({ character: { avatar: { look } } }),
        (e: unknown) => {
          assert.ok(e instanceof ValidationError, String(e));
          assert.equal(e.field, field, e.message);
          if (message) assert.match(e.message, message);
          return true;
        },
      );
    const p1 = r.store.saveProfile({ character: { avatar: { look: { kind: "figure", figure: FIGURE }, hue: 10 } } });
    assert.deepEqual(p1.character.avatar.look, { kind: "figure", figure: FIGURE });
    assert.equal(p1.character.avatar.hue, 10);
    assert.equal(p1.character.avatar.glow, 60, "a field not mentioned keeps its value");
    const p2 = r.store.saveProfile({ character: { avatar: { glow: 20 } } });
    assert.deepEqual(p2.character.avatar.look, { kind: "figure", figure: FIGURE }, "a change to another field leaves the look alone");
    const p2b = r.store.saveProfile({ character: { avatar: { look: { kind: "companion", id: "vesper" }, hue: 75, glow: 68 } } });
    assert.deepEqual(p2b.character.avatar.look, { kind: "companion", id: "vesper" });
    const p3 = r.store.saveProfile({ character: { avatar: { look: { kind: "sigil" }, glow: 20 } } });
    assert.deepEqual(p3.character.avatar.look, { kind: "sigil" });
    assert.equal(p3.character.avatar.glow, 20);

    bad(null, "character.avatar.look", /must be an object/);
    bad({ kind: "dragon" }, "character.avatar.look.kind", /one of sigil, companion, figure, pack/);
    bad({ kind: "sigil", extra: 1 }, "character.avatar.look.extra", /unknown field/);
    bad({ kind: "companion" }, "character.avatar.look.id", /companion id/);
    bad({ kind: "companion", id: "UpperCase" }, "character.avatar.look.id", /companion id/);
    bad({ kind: "companion", id: "vesper", extra: 1 }, "character.avatar.look.extra", /unknown field/);
    bad({ kind: "figure" }, "character.avatar.look.figure", /must be an object/);
    bad({ kind: "figure", figure: { ...FIGURE, hat: "cap" } }, "character.avatar.look.figure.hat", /unknown field/);
    bad({ kind: "figure", figure: without(FIGURE, "shade") }, "character.avatar.look.figure.shade", /required/);
    bad({ kind: "figure", figure: { ...FIGURE, body: "Round" } }, "character.avatar.look.figure.body", /part id/);
    bad({ kind: "figure", figure: { ...FIGURE, accent: 360 } }, "character.avatar.look.figure.accent", /between 0 and 359/);
    bad({ kind: "figure", figure: FIGURE, id: "x" }, "character.avatar.look.id", /unknown field/);
    bad({ kind: "pack" }, "character.avatar.look.id", /id of a saved avatar/);
    bad({ kind: "pack", id: "spaces here" }, "character.avatar.look.id");
    bad({ kind: "pack", id: "av_0123456789abcdef" }, "character.avatar.look.id", /no such avatar/);
    bad({ kind: "pack", id: "av_0123456789abcdef", name: "x" }, "character.avatar.look.name", /unknown field/);
    assert.deepEqual(r.store.getProfile().character.avatar.look, { kind: "sigil" }, "nothing of the refused changes was kept");
  });

  it("follows a saved avatar: the revision is its updatedAt, an edit moves both, and deleting it falls back to the sigil", () => {
    const r = rig();
    const pack = r.store.createAvatar(pixelInput("Worn"));
    const other = r.store.createAvatar(figureInput("Spare"));
    r.clock.t += MIN;
    const worn = r.store.saveProfile({ character: { avatar: { look: { kind: "pack", id: pack.id, rev: 999 } } } });
    assert.deepEqual(worn.character.avatar.look, { kind: "pack", id: pack.id, rev: pack.updatedAt }, "the revision sent is ignored; the avatar's own is used");

    r.clock.t += MIN;
    const untouched = r.store.updateAvatar(other.id, { name: "Still spare" });
    assert.equal(r.store.getProfile().updatedAt, worn.updatedAt, "editing an avatar it does not wear leaves the profile alone");
    assert.ok(untouched.updatedAt > pack.updatedAt);

    r.clock.t += MIN;
    const edited = r.store.updateAvatar(pack.id, { data: { ...pixelInput().data, palette: ["#123456", "#654321"] } });
    const after = r.store.getProfile();
    assert.deepEqual(after.character.avatar.look, { kind: "pack", id: pack.id, rev: edited.updatedAt });
    assert.equal(after.updatedAt, r.clock.t, "the profile moved with it, so a stale page is told");
    assert.ok(after.updatedAt > worn.updatedAt);

    r.clock.t += MIN;
    r.store.deleteAvatar(other.id);
    assert.deepEqual(r.store.getProfile().character.avatar.look, { kind: "pack", id: pack.id, rev: edited.updatedAt }, "deleting another avatar changes nothing");
    r.store.deleteAvatar(pack.id);
    const bare = r.store.getProfile();
    assert.deepEqual(bare.character.avatar.look, { kind: "sigil" });
    assert.equal(bare.updatedAt, r.clock.t);
    assert.equal(bare.character.avatar.hue, DEFAULT_CHARACTER.avatar.hue, "the sigil's own settings are as they were");
  });
});

// ------------------------------------------------------------------------------------------------ HTTP

describe("the avatar routes", () => {
  it("list, create, read, change, refuse a stale change, and delete, telling the clients each time", async () => {
    const r = rig();
    const empty = await call(r, "GET", "/api/assistant/avatars");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { avatars: [], limits: { count: 24, perAvatarBytes: 700_000, totalBytes: 8_000_000, used: 0, total: 0 } });

    const made = await call(r, "POST", "/api/assistant/avatars", pixelInput("Blip"));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const avatar = (made.body as { avatar: AvatarPack }).avatar;
    assert.equal(avatar.kind, "pixel");
    assert.equal(r.events.filter((e) => e.reason === "profile").length, 1, "a write is announced as a profile change: the page reloads its library with it");

    const listed = (await call(r, "GET", "/api/assistant/avatars")).body as { avatars: { id: string }[]; limits: { used: number; total: number } };
    assert.deepEqual(listed.avatars.map((a) => a.id), [avatar.id]);
    assert.deepEqual(listed.limits.total, 1);
    assert.equal(listed.limits.used, avatar.bytes);

    const one = await call(r, "GET", `/api/assistant/avatars/${avatar.id}`);
    assert.equal(one.status, 200);
    assert.deepEqual((one.body as { avatar: AvatarPack }).avatar, avatar);
    const missing = await call(r, "GET", "/api/assistant/avatars/av_0000000000000000");
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { kind: string }).kind, "not_found");

    const invalid = await call(r, "POST", "/api/assistant/avatars", withData(pixelInput(), { w: 3 }));
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body, { error: "data.w must be between 8 and 64", kind: "invalid", field: "data.w" });

    r.clock.t += MIN;
    const renamed = await call(r, "PATCH", `/api/assistant/avatars/${avatar.id}`, { name: "Blip II", expectedUpdatedAt: avatar.updatedAt });
    assert.equal(renamed.status, 200);
    assert.equal((renamed.body as { avatar: AvatarPack }).avatar.name, "Blip II");
    assert.equal("profile" in (renamed.body as object), false, "the profile does not wear it, so it is not sent back");
    const stale = await call(r, "PATCH", `/api/assistant/avatars/${avatar.id}`, { name: "Blip III", expectedUpdatedAt: avatar.updatedAt });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.body, { error: "The avatar changed since you opened it.", kind: "conflict", current: (renamed.body as { avatar: AvatarPack }).avatar.updatedAt });
    assert.equal((await call(r, "PATCH", `/api/assistant/avatars/${avatar.id}`, { name: "x", expectedUpdatedAt: "later" })).status, 400);
    assert.equal((await call(r, "PATCH", `/api/assistant/avatars/${avatar.id}`, { kind: "image" })).status, 400);

    const gone = await call(r, "DELETE", `/api/assistant/avatars/${avatar.id}`);
    assert.deepEqual(gone, { status: 200, body: { ok: true } });
    assert.equal((await call(r, "GET", `/api/assistant/avatars/${avatar.id}`)).status, 404);
    assert.equal((await call(r, "DELETE", `/api/assistant/avatars/${avatar.id}`)).status, 404);
    assert.equal((await call(r, "GET", "/api/assistant/avatars/not%20an%20id")).status, 404);
  });

  it("returns the profile with a change to the avatar the assistant wears, and the export carries the whole library", async () => {
    const r = rig();
    const avatar = ((await call(r, "POST", "/api/assistant/avatars", figureInput("Worn"))).body as { avatar: AvatarPack }).avatar;
    const worn = await call(r, "PATCH", "/api/assistant/profile", { character: { avatar: { look: { kind: "pack", id: avatar.id } } } });
    assert.equal(worn.status, 200, JSON.stringify(worn.body));
    assert.deepEqual((worn.body as { profile: { character: { avatar: { look: unknown } } } }).profile.character.avatar.look, { kind: "pack", id: avatar.id, rev: avatar.updatedAt });
    const dangling = await call(r, "PATCH", "/api/assistant/profile", { character: { avatar: { look: { kind: "pack", id: "av_0000000000000000" } } } });
    assert.equal(dangling.status, 400);
    assert.deepEqual(dangling.body, { error: "no such avatar", kind: "invalid", field: "character.avatar.look.id" });

    r.clock.t += MIN;
    const edited = await call(r, "PATCH", `/api/assistant/avatars/${avatar.id}`, { data: { figure: FIGURE, hue: 1, glow: 1 } });
    assert.equal(edited.status, 200);
    const body = edited.body as { avatar: AvatarPack; profile: { updatedAt: number; character: { avatar: { look: unknown } } } };
    assert.deepEqual(body.profile.character.avatar.look, { kind: "pack", id: avatar.id, rev: body.avatar.updatedAt });
    assert.equal(body.profile.updatedAt, r.clock.t);

    const exported = (await call(r, "GET", "/api/assistant/export")).body as { format: string; version: number; avatars: AvatarPack[] };
    assert.equal(exported.format, "ancilla.assistant.export");
    assert.equal(exported.version, 1);
    assert.deepEqual(exported.avatars, [body.avatar]);

    await call(r, "DELETE", `/api/assistant/avatars/${avatar.id}`);
    assert.deepEqual(((await call(r, "GET", "/api/assistant")).body as { profile: { character: { avatar: { look: unknown } } } }).profile.character.avatar.look, { kind: "sigil" });
  });

  it("answers for an assistant nobody has used without creating it", async () => {
    let created = 0;
    const r = rig();
    const lazy = { get: (create: boolean) => (create ? ((created += 1), r.service) : null), unavailable: () => null };
    const request = (method: string, path: string, body: Record<string, unknown> = {}) => handleAssistant(lazy, { method, path, query: new URLSearchParams(), body: async () => body });
    const list = await request("GET", "/api/assistant/avatars");
    assert.equal(list?.status, 200);
    assert.deepEqual(list?.body, { avatars: [], limits: { count: 24, perAvatarBytes: 700_000, totalBytes: 8_000_000, used: 0, total: 0 } });
    assert.equal((await request("GET", "/api/assistant/avatars/av_0000000000000000"))?.status, 404);
    const exported = (await request("GET", "/api/assistant/export"))?.body as { avatars: unknown[] };
    assert.deepEqual(exported.avatars, []);
    assert.equal(created, 0, "looking creates nothing");
    assert.equal((await request("POST", "/api/assistant/avatars", figureInput()))?.status, 201);
    assert.equal(created, 1, "the first avatar is what makes the file");
  });

  it("leaves no file behind a look at the library on the real server, and makes one for the first avatar saved", async () => {
    const dataDir = await temp("ancilla-avatars-data-");
    const { base } = await start(new FakeConnection(), { dataDir });
    const files = async () => (await readdir(dataDir)).filter((name) => name.startsWith("assistant.db"));
    const list = await send(base, "/api/assistant/avatars", undefined, "GET");
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.avatars, []);
    assert.deepEqual(await files(), [], "nothing on disk yet");
    const made = await send(base, "/api/assistant/avatars", imageInput("Photo", webp(), 1, 1, "webp"));
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.ok((await files()).includes("assistant.db"), "saving an avatar made the file");
    const one = await send(base, `/api/assistant/avatars/${made.json.avatar.id}`, undefined, "GET");
    assert.equal(one.json.avatar.data.src, dataUrl("webp", webp()));
  });
});
