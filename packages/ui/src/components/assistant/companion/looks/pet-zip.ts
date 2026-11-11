import { PictureError } from "./bring-io.js";

/**
 * Unpacks a desktop-pet `.zip` archive in memory so the user can drop a downloaded pet package straight onto
 * "Bring your own" without extracting it by hand first. Reads the central directory, checks every size ceiling
 * before allocating, and decompresses only `pet.json` and the sprite sheet image.
 */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_ARCHIVE_BYTES = 40_000_000;
const MAX_ENTRY_BYTES = 40_000_000;

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
}

export interface UnpackedPet {
  file: File;
  title: string;
  /** True when the archive came with a `pet.json` manifest or desktop-pet spritesheet convention. */
  desktopPet: boolean;
}

const u16 = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, at: number): number => ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>> 0;

function mimeForName(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  return null;
}

const isJunkPath = (name: string): boolean => {
  const clean = name.replace(/\\/g, "/");
  if (clean.startsWith("__MACOSX/") || clean.includes("/__MACOSX/")) return true;
  const base = clean.split("/").pop() ?? "";
  return base.startsWith("._") || base === ".DS_Store";
};

/** Reads the central directory of a standard ZIP buffer. */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new PictureError("That archive is too large. Shrink or unpack the picture first.");
  if (bytes.byteLength < 22) throw new PictureError("That ZIP archive is empty or damaged.");
  const minOffset = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= minOffset; i -= 1) {
    if (u32(bytes, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new PictureError("That file could not be read as a ZIP archive.");
  const total = u16(bytes, eocd + 10);
  const cdOffset = u32(bytes, eocd + 16);
  if (cdOffset >= bytes.byteLength) throw new PictureError("That ZIP archive has a damaged directory.");

  const decoder = new TextDecoder("utf-8");
  const out: ZipEntry[] = [];
  let pos = cdOffset;
  for (let i = 0; i < total && pos + 46 <= bytes.byteLength; i += 1) {
    if (u32(bytes, pos) !== CD_SIG) throw new PictureError("That ZIP archive has an unreadable entry.");
    const method = u16(bytes, pos + 10);
    const compSize = u32(bytes, pos + 20);
    const uncompSize = u32(bytes, pos + 24);
    const nameLen = u16(bytes, pos + 28);
    const extraLen = u16(bytes, pos + 30);
    const commentLen = u16(bytes, pos + 32);
    const localOffset = u32(bytes, pos + 42);
    const nameEnd = pos + 46 + nameLen;
    if (nameEnd > bytes.byteLength) throw new PictureError("That ZIP archive ends mid-entry.");
    const name = decoder.decode(bytes.subarray(pos + 46, nameEnd));
    if (!name.endsWith("/")) out.push({ name, method, compSize, uncompSize, localOffset });
    pos = nameEnd + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(compressed: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new PictureError("This browser cannot unpack compressed ZIP archives. Unpack the picture first.");
  const stream = new Blob([compressed as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) throw new PictureError("A file inside that archive is too large to unpack.");
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.uncompSize > MAX_ENTRY_BYTES || entry.compSize > MAX_ARCHIVE_BYTES) {
    throw new PictureError("A file inside that archive is too large to use as an avatar.");
  }
  const loc = entry.localOffset;
  if (loc + 30 > bytes.byteLength || u32(bytes, loc) !== LOCAL_SIG) throw new PictureError("That ZIP archive has a damaged file header.");
  const nameLen = u16(bytes, loc + 26);
  const extraLen = u16(bytes, loc + 28);
  const start = loc + 30 + nameLen + extraLen;
  const end = start + entry.compSize;
  if (end > bytes.byteLength) throw new PictureError("That ZIP archive is truncated.");
  const slice = bytes.subarray(start, end);
  if (entry.method === 0) return slice.slice();
  if (entry.method === 8) return inflateRaw(slice, MAX_ENTRY_BYTES);
  throw new PictureError("That ZIP archive uses an unsupported compression method. Unpack the picture first.");
}

function cleanTitle(raw: string): string {
  return raw.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim().slice(0, 40);
}

/** Extracts the sprite sheet (or picture) and optional `pet.json` metadata from a `.zip` buffer. */
export async function unpackPetArchive(archiveBytes: Uint8Array, archiveFileName: string): Promise<UnpackedPet> {
  const entries = listZipEntries(archiveBytes).filter((e) => !isJunkPath(e.name));
  const manifestEntry = entries.find((e) => /(?:^|\/)pet\.json$/i.test(e.name.replace(/\\/g, "/")));

  let displayName = "";
  let wantedSheet = "";
  if (manifestEntry && manifestEntry.uncompSize <= 256_000) {
    try {
      const rawJson = new TextDecoder("utf-8").decode(await readZipEntry(archiveBytes, manifestEntry));
      const parsed: unknown = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.displayName === "string" && obj.displayName.trim()) displayName = obj.displayName.trim().slice(0, 40);
        else if (typeof obj.name === "string" && obj.name.trim()) displayName = obj.name.trim().slice(0, 40);
        if (typeof obj.spritesheetPath === "string" && obj.spritesheetPath.trim()) {
          wantedSheet = obj.spritesheetPath.replace(/^\.?\//, "").replace(/\\/g, "/").toLowerCase();
        }
      }
    } catch {
      // A malformed manifest does not stop us from reading the sprite sheet beside it.
    }
  }

  const imageEntries = entries.filter((e) => mimeForName(e.name) !== null);
  if (imageEntries.length === 0) {
    throw new PictureError("No PNG, WebP, JPEG or GIF picture was found inside that ZIP archive.");
  }

  const chosen =
    (wantedSheet ? imageEntries.find((e) => e.name.replace(/\\/g, "/").toLowerCase().endsWith(wantedSheet)) : undefined) ??
    imageEntries.find((e) => /(?:^|\/)spritesheet\.(webp|png)$/i.test(e.name.replace(/\\/g, "/"))) ??
    [...imageEntries].sort((a, b) => b.uncompSize - a.uncompSize)[0]!;

  const imageBytes = await readZipEntry(archiveBytes, chosen);
  const baseName = chosen.name.replace(/\\/g, "/").split("/").pop() ?? "spritesheet.webp";
  const mime = mimeForName(baseName) ?? "image/png";
  const file = new File([imageBytes as Uint8Array<ArrayBuffer>], baseName, { type: mime });
  const fallbackTitle = cleanTitle(archiveFileName) || cleanTitle(baseName) || "My companion";
  const desktopPet = Boolean(manifestEntry) || /^spritesheet\.(webp|png)$/i.test(baseName);

  return {
    file,
    title: displayName || fallbackTitle,
    desktopPet,
  };
}
