import { integer, isObj, parseFigure, textField, ValidationError } from "./profile.js";
import type { AvatarMoodId, AvatarPack, FigurePackData, ImagePackData, PixelData } from "./types.js";

/**
 * What a saved avatar may be. Everything a client sends for one is checked here, field by field, before it is stored:
 * the pixel frames are decoded and measured, a picture's bytes are read for the signature of the type it claims to be
 * and (for PNG) the size in its header, and every number is a whole number inside its range. A refusal names the field
 * and the reason, so the page can point at it. The limits are small on purpose: an avatar is drawn at a few dozen
 * pixels, and the whole library travels with the assistant's export.
 */

/** How many avatars the library holds. */
export const MAX_AVATARS = 24;
/** The size of one avatar's `data` as JSON. */
export const MAX_AVATAR_BYTES = 700_000;
/** The size of every avatar's `data` together. */
export const MAX_TOTAL_AVATAR_BYTES = 8_000_000;
export const MAX_AVATAR_NAME = 40;
/** A picture's decoded bytes. (Its JSON form is a third larger, so the 700 KB ceiling on `data` reaches it first at about 520 KB.) */
export const MAX_IMAGE_BYTES = 600_000;

export const AVATAR_KINDS = ["figure", "pixel", "image"] as const;
export type AvatarKind = (typeof AVATAR_KINDS)[number];
export const MOODS: readonly AvatarMoodId[] = ["idle", "working", "attention", "delight", "concern", "asleep"];

export type AvatarData = FigurePackData | PixelData | ImagePackData;
export type AvatarInput = Pick<AvatarPack, "name" | "kind" | "data">;

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
const DATA_URL = /^data:image\/(png|webp|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function keysOnly(raw: Record<string, unknown>, field: string, allowed: readonly string[]): void {
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new ValidationError(`${field}.${key}`, `unknown field ${field}.${key}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isObj(value)) throw new ValidationError(field, `${field} must be an object`);
  return value;
}

function required(raw: Record<string, unknown>, field: string, keys: readonly string[]): void {
  for (const key of keys) if (!(key in raw)) throw new ValidationError(`${field}.${key}`, `${field}.${key} is required`);
}

/** The mood names a `moods` object may have, with `idle` among them: it is what is shown when nothing else applies. */
function moodKeys(raw: Record<string, unknown>, field: string): AvatarMoodId[] {
  const keys = Object.keys(raw);
  for (const key of keys) if (!(MOODS as readonly string[]).includes(key)) throw new ValidationError(`${field}.${key}`, `${field}.${key} is not a mood; the moods are ${MOODS.join(", ")}`);
  if (!keys.includes("idle")) throw new ValidationError(`${field}.idle`, `${field}.idle is required: it is what is shown when nothing else applies`);
  return keys as AvatarMoodId[];
}

/**
 * Base64 as `Buffer` would write it, and nothing else: no whitespace, no URL alphabet, no stray bits in the last
 * character. Decoding is forgiving, so the only sure test is to decode and write it again.
 */
function canonicalBase64(value: string, field: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new ValidationError(field, `${field} must be base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new ValidationError(field, `${field} must be canonical base64`);
  return bytes;
}

function parseFigureData(raw: Record<string, unknown>): FigurePackData {
  keysOnly(raw, "data", ["figure", "hue", "glow"]);
  required(raw, "data", ["figure", "hue", "glow"]);
  return { figure: parseFigure(raw.figure, "data.figure"), hue: integer(raw.hue, "data.hue", 0, 359), glow: integer(raw.glow, "data.glow", 0, 100) };
}

function parsePixelData(raw: Record<string, unknown>): PixelData {
  keysOnly(raw, "data", ["w", "h", "palette", "moods"]);
  required(raw, "data", ["w", "h", "palette", "moods"]);
  const w = integer(raw.w, "data.w", 8, 64);
  const h = integer(raw.h, "data.h", 8, 64);
  if (!Array.isArray(raw.palette)) throw new ValidationError("data.palette", "data.palette must be a list of colours");
  if (raw.palette.length < 1 || raw.palette.length > 32) throw new ValidationError("data.palette", "data.palette must have between 1 and 32 colours");
  const palette = raw.palette.map((c, i) => {
    if (typeof c !== "string" || !HEX_COLOUR.test(c)) throw new ValidationError(`data.palette[${i}]`, `data.palette[${i}] must be a colour like #1a2b3c`);
    return c.toLowerCase();
  });
  const moodsRaw = object(raw.moods, "data.moods");
  const moods: PixelData["moods"] = {};
  let frames = 0;
  for (const mood of moodKeys(moodsRaw, "data.moods")) {
    const field = `data.moods.${mood}`;
    const m = object(moodsRaw[mood], field);
    keysOnly(m, field, ["ms", "frames"]);
    required(m, field, ["ms", "frames"]);
    const ms = integer(m.ms, `${field}.ms`, 40, 2000);
    if (!Array.isArray(m.frames) || m.frames.length < 1 || m.frames.length > 8) throw new ValidationError(`${field}.frames`, `${field}.frames must be a list of 1 to 8 frames`);
    frames += m.frames.length;
    if (frames > 32) throw new ValidationError("data.moods", "a pixel avatar has at most 32 frames over all its moods");
    const list = m.frames.map((frame, i) => {
      const where = `${field}.frames[${i}]`;
      if (typeof frame !== "string") throw new ValidationError(where, `${where} must be base64 text`);
      const cells = canonicalBase64(frame, where);
      if (cells.length !== w * h) throw new ValidationError(where, `${where} must hold ${w * h} cells (${w} by ${h}), not ${cells.length}`);
      for (const cell of cells) if (cell > palette.length) throw new ValidationError(where, `${where} points at colour ${cell}, and the palette has ${palette.length}`);
      return frame;
    });
    moods[mood] = { ms, frames: list };
  }
  return { w, h, palette, moods };
}

/** The first bytes a file of this type always starts with. */
function hasMagic(bytes: Buffer, type: string): boolean {
  if (type === "png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC);
  if (type === "jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
}

function parseImageData(raw: Record<string, unknown>): ImagePackData {
  keysOnly(raw, "data", ["src", "w", "h", "crisp", "sheet"]);
  required(raw, "data", ["src", "w", "h", "crisp"]);
  if (typeof raw.src !== "string") throw new ValidationError("data.src", "data.src must be text");
  const match = DATA_URL.exec(raw.src);
  if (!match) throw new ValidationError("data.src", "data.src must be a data URL of a PNG, WebP or JPEG picture in base64");
  const type = match[1] as string;
  const bytes = Buffer.from(match[2] as string, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) throw new ValidationError("data.src", `the picture is ${bytes.length} bytes, and an avatar may be at most ${MAX_IMAGE_BYTES}`);
  if (!hasMagic(bytes, type)) throw new ValidationError("data.src", `data.src says it is a ${type.toUpperCase()}, but its bytes are not one`);
  const w = integer(raw.w, "data.w", 1, 4096);
  const h = integer(raw.h, "data.h", 1, 4096);
  if (type === "png") {
    // The IHDR chunk is always first: its width and height sit right after the signature and the chunk header.
    if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") throw new ValidationError("data.src", "the PNG has no IHDR header");
    const realW = bytes.readUInt32BE(16);
    const realH = bytes.readUInt32BE(20);
    if (realW !== w || realH !== h) throw new ValidationError("data.w", `the PNG is ${realW} by ${realH}, not ${w} by ${h}`);
  }
  if (typeof raw.crisp !== "boolean") throw new ValidationError("data.crisp", "data.crisp must be true or false");
  const out: ImagePackData = { src: raw.src, w, h, crisp: raw.crisp };
  if (raw.sheet !== undefined) {
    const s = object(raw.sheet, "data.sheet");
    keysOnly(s, "data.sheet", ["cols", "rows", "moods"]);
    required(s, "data.sheet", ["cols", "rows", "moods"]);
    const cols = integer(s.cols, "data.sheet.cols", 1, 16);
    const rows = integer(s.rows, "data.sheet.rows", 1, 16);
    const moodsRaw = object(s.moods, "data.sheet.moods");
    const moods: NonNullable<ImagePackData["sheet"]>["moods"] = {};
    for (const mood of moodKeys(moodsRaw, "data.sheet.moods")) {
      const field = `data.sheet.moods.${mood}`;
      const m = object(moodsRaw[mood], field);
      keysOnly(m, field, ["row", "frames", "ms"]);
      required(m, field, ["row", "frames", "ms"]);
      moods[mood] = { row: integer(m.row, `${field}.row`, 0, rows - 1), frames: integer(m.frames, `${field}.frames`, 1, cols), ms: integer(m.ms, `${field}.ms`, 40, 2000) };
    }
    out.sheet = { cols, rows, moods };
  }
  return out;
}

/** The `data` of an avatar of `kind`, checked and normalized (palette colours in lower case, nothing unknown kept). */
export function parseAvatarData(kind: AvatarKind, raw: unknown): AvatarData {
  const data = object(raw, "data");
  const out = kind === "figure" ? parseFigureData(data) : kind === "pixel" ? parsePixelData(data) : parseImageData(data);
  const bytes = avatarBytes(out);
  if (bytes > MAX_AVATAR_BYTES) throw new ValidationError("data", `this avatar is ${bytes} bytes, and one may be at most ${MAX_AVATAR_BYTES}`);
  return out;
}

/** What an avatar's data costs in the library: the size of its JSON. */
export function avatarBytes(data: AvatarData): number {
  return Buffer.byteLength(JSON.stringify(data));
}

export function parseAvatarName(value: unknown): string {
  const name = textField(value, "name", MAX_AVATAR_NAME);
  if (name === "") throw new ValidationError("name", "an avatar needs a name");
  return name;
}

/** A new avatar as the user sent it: `{ name, kind, data }` and nothing else. */
export function parseAvatarInput(raw: unknown): AvatarInput {
  const r = object(raw, "body");
  keysOnly(r, "body", ["name", "kind", "data"]);
  required(r, "body", ["name", "kind", "data"]);
  const name = parseAvatarName(r.name);
  if (typeof r.kind !== "string" || !(AVATAR_KINDS as readonly string[]).includes(r.kind)) throw new ValidationError("kind", `kind must be one of ${AVATAR_KINDS.join(", ")}`);
  const kind = r.kind as AvatarKind;
  return { name, kind, data: parseAvatarData(kind, r.data) } as AvatarInput;
}

/** A change to an avatar: a new name, new data of the same kind, or both. The kind itself cannot change. */
export function parseAvatarPatch(raw: unknown, kind: AvatarKind): { name?: string; data?: AvatarData } {
  const r = object(raw, "body");
  keysOnly(r, "body", ["name", "data"]);
  const out: { name?: string; data?: AvatarData } = {};
  if ("name" in r) out.name = parseAvatarName(r.name);
  if ("data" in r) out.data = parseAvatarData(kind, r.data);
  if (!("name" in r) && !("data" in r)) throw new ValidationError("body", "nothing to change: send a name, data, or both");
  return out;
}
