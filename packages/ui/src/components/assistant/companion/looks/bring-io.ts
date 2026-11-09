import type { ImagePackData } from "../../../../types.js";
import { MAX_PICTURE_BYTES, MAX_PIXELS, MAX_SIDE_PX, dataUrlBytes, fitScale, storedSize } from "./raster.js";

/**
 * The browser half of bringing a picture in: reading a file into pixels, and writing the picture back out small enough to
 * keep. The arithmetic is in `raster.ts`; this is the part that needs a canvas.
 */

export interface LoadedPicture {
  image: HTMLImageElement;
  /** Where the picture can be shown from while it is being set up; revoked by `release`. */
  url: string;
  w: number;
  h: number;
}

export class PictureError extends Error {}

const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Reads a picture file, refusing what is not one or is too large to be worth keeping, in words. */
export async function loadPicture(file: File): Promise<LoadedPicture> {
  if (!TYPES.includes(file.type) && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) throw new PictureError("That is not a picture Ancilla can read. Use a PNG, JPEG, WebP or GIF.");
  if (file.size > 40_000_000) throw new PictureError("That picture is very large. Shrink it first; a face never needs more than a few hundred pixels.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    if (w < 1 || h < 1) throw new PictureError("That picture is empty.");
    if (w > MAX_SIDE_PX || h > MAX_SIDE_PX) throw new PictureError(`That picture is ${w} by ${h} pixels, which is more than can be used here (at most ${MAX_SIDE_PX} on a side).`);
    if (w * h > MAX_PIXELS) throw new PictureError(`That picture is ${w} by ${h} pixels, which is more than can be used here (at most ${Math.round(MAX_PIXELS / 1_000_000)} million pixels in all).`);
    return { image, url, w, h };
  } catch (e) {
    URL.revokeObjectURL(url);
    if (e instanceof PictureError) throw e;
    throw new PictureError("That file could not be read as a picture.");
  }
}

export const release = (picture: LoadedPicture | null): void => {
  if (picture) URL.revokeObjectURL(picture.url);
};

/** All of a picture's pixels, for finding which cells of a sheet have something in them. */
export function readPixels(picture: LoadedPicture): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = picture.w;
  canvas.height = picture.h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new PictureError("This browser cannot read pictures.");
  ctx.drawImage(picture.image, 0, 0);
  return ctx.getImageData(0, 0, picture.w, picture.h).data;
}

export interface EncodeOptions {
  cols: number;
  rows: number;
  /** The longest side a single cell is stored at. */
  maxCell: number;
  /** Scale without smoothing, for pixel art. */
  crisp: boolean;
  /** Cut each cell to a circle (for a photograph or a logo). */
  circle: boolean;
}

export interface Encoded {
  src: string;
  w: number;
  h: number;
  bytes: number;
}

/** Draws the picture cell by cell at the stored size and encodes it, shrinking further until it fits what the server keeps. */
export function encodePicture(picture: LoadedPicture, opts: EncodeOptions): Encoded {
  const cw0 = picture.w / opts.cols;
  const ch0 = picture.h / opts.rows;
  let scale = fitScale(picture.w, picture.h, opts.cols, opts.rows, opts.maxCell, 1_200_000);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const size = storedSize(picture.w, picture.h, opts.cols, opts.rows, scale);
    const canvas = document.createElement("canvas");
    canvas.width = size.w;
    canvas.height = size.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PictureError("This browser cannot write pictures.");
    ctx.imageSmoothingEnabled = !opts.crisp;
    ctx.imageSmoothingQuality = "high";
    for (let r = 0; r < opts.rows; r += 1) {
      for (let c = 0; c < opts.cols; c += 1) {
        ctx.save();
        if (opts.circle) {
          ctx.beginPath();
          ctx.arc(c * size.cw + size.cw / 2, r * size.ch + size.ch / 2, Math.min(size.cw, size.ch) / 2, 0, Math.PI * 2);
          ctx.clip();
        }
        ctx.drawImage(picture.image, Math.floor(c * cw0), Math.floor(r * ch0), Math.floor(cw0), Math.floor(ch0), c * size.cw, r * size.ch, size.cw, size.ch);
        ctx.restore();
      }
    }
    // WebP where the browser writes it (smaller, and keeps transparency); otherwise PNG, which every browser writes.
    let src = canvas.toDataURL("image/webp", opts.crisp ? 1 : 0.9);
    if (!src.startsWith("data:image/webp")) src = canvas.toDataURL("image/png");
    const bytes = dataUrlBytes(src);
    if (bytes <= MAX_PICTURE_BYTES) return { src, w: size.w, h: size.h, bytes };
    scale *= 0.82;
  }
  throw new PictureError("That picture is too detailed to keep at this size. Try a smaller picture or fewer frames.");
}

/** What an encoded picture is, as avatar data. */
export function pictureData(encoded: Encoded, sheet: ImagePackData["sheet"] | undefined, crisp: boolean): ImagePackData {
  return { src: encoded.src, w: encoded.w, h: encoded.h, ...(sheet ? { sheet } : {}), crisp };
}
