import type { PixelData } from "../../../../types.js";
import { PIXEL_MOODS, frameToRgba, framesOf } from "./pixel.js";

/**
 * The studio's way in and out of the browser: a picture file to RGBA bytes, a frame or the whole animation to a PNG,
 * and a download. Everything here needs a document and a canvas, so it stays apart from the pure library.
 */

export interface DecodedImage {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
}

/** Pictures larger than this on a side are shrunk before anything else: a photo straight from a camera would otherwise take seconds to count. */
export const MAX_IMPORT_SIDE = 2048;

export const NOT_A_PICTURE = "That file is not a picture we can read.";

type Drawable = ImageBitmap | HTMLImageElement;

async function loadImageElement(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(NOT_A_PICTURE));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decode(file: Blob): Promise<Drawable> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Some browsers refuse a format here that an <img> still shows; try that way before giving up.
    }
  }
  return loadImageElement(file);
}

/** The picture's pixels, shrunk to fit `MAX_IMPORT_SIDE` when it is larger. Throws `NOT_A_PICTURE` when it cannot be read. */
export async function decodeImageFile(file: Blob): Promise<DecodedImage> {
  let source: Drawable;
  try {
    source = await decode(file);
  } catch {
    throw new Error(NOT_A_PICTURE);
  }
  const sw = "naturalWidth" in source ? source.naturalWidth : source.width;
  const sh = "naturalHeight" in source ? source.naturalHeight : source.height;
  if (!sw || !sh) throw new Error(NOT_A_PICTURE);
  const scale = Math.min(1, MAX_IMPORT_SIDE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(NOT_A_PICTURE);
  ctx.drawImage(source, 0, 0, w, h);
  if ("close" in source) source.close();
  const { data } = ctx.getImageData(0, 0, w, h);
  return { rgba: new Uint8ClampedArray(data), w, h };
}

/** A canvas holding these pixels at one pixel per cell, to be drawn scaled with smoothing off. */
export function rgbaCanvas(rgba: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const image = ctx.createImageData(w, h);
    image.data.set(rgba);
    ctx.putImageData(image, 0, 0);
  }
  return canvas;
}

/** Draws a frame onto a canvas at `scale` device pixels per cell, crisp. */
export function drawFrame(ctx: CanvasRenderingContext2D, palette: readonly string[], frame: Uint8Array, w: number, h: number, x: number, y: number, scale: number): void {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(rgbaCanvas(frameToRgba(palette, frame, w, h), w, h), x, y, w * scale, h * scale);
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The picture could not be made."))), "image/png"));
}

/** One frame as a PNG, `scale` pixels per cell. */
export function framePng(data: PixelData, frame: Uint8Array, scale = 8): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = data.w * scale;
  canvas.height = data.h * scale;
  const ctx = canvas.getContext("2d");
  if (ctx) drawFrame(ctx, data.palette, frame, data.w, data.h, 0, 0, scale);
  return toBlob(canvas);
}

/** The whole animation as one PNG: a row per mood in order, a column per frame. A mood wearing the resting frames shows their first once. */
export function sheetPng(data: PixelData, scale = 4): Promise<Blob> {
  const rows = PIXEL_MOODS.map((mood) => {
    const shown = framesOf(data, mood);
    return shown.own ? shown.frames : shown.frames.slice(0, 1);
  });
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const canvas = document.createElement("canvas");
  canvas.width = cols * data.w * scale;
  canvas.height = rows.length * data.h * scale;
  const ctx = canvas.getContext("2d");
  if (ctx) rows.forEach((frames, row) => frames.forEach((frame, col) => drawFrame(ctx, data.palette, frame, data.w, data.h, col * data.w * scale, row * data.h * scale, scale)));
  return toBlob(canvas);
}

/** Hands the browser a file to save, through a link that lives for the click. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name from what the user called the avatar, safe for any system. */
export const fileStem = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pixel-avatar";
