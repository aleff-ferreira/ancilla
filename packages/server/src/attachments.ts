/**
 * How a file attached to a prompt is described and served back. The type a client names is data from outside, so it
 * is cleaned when it is stored and again when it is read, which also covers rows saved before this existed. A stored
 * file is only ever shown as an image or downloaded: nothing served from here may run as a page on the daemon's
 * origin, which holds the token cookie.
 */

/** The type of anything that is not a plain, well-formed `type/subtype`. */
export const OPAQUE_MEDIA_TYPE = "application/octet-stream";

/** Longer than any real type, and short enough to ride in a header and in a database row without trouble. */
const MAX_MEDIA_TYPE_LENGTH = 100;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** Spellings of one type that browsers, scanners and older files use. */
const ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
};

/** Raster images a browser draws and cannot run. SVG is not among them: it is a document that can carry script. */
const PASSIVE_IMAGES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/jxl",
]);

/** What sandboxes a stored file that is opened as a page: no script, no plugins, no way to reach the daemon. */
export const SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

/** One lower-case `type/subtype`, without parameters; anything else is opaque bytes. */
export function normalizeMediaType(raw: unknown): string {
  if (typeof raw !== "string") {
    return OPAQUE_MEDIA_TYPE;
  }
  const bare = (raw.split(";", 1)[0] ?? "").trim().toLowerCase();
  if (bare.length === 0 || bare.length > MAX_MEDIA_TYPE_LENGTH || !MEDIA_TYPE.test(bare)) {
    return OPAQUE_MEDIA_TYPE;
  }
  return ALIASES[bare] ?? bare;
}

const MAX_NAME_CHARS = 80;

/** A name that is safe inside a quoted header value. */
function headerName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, MAX_NAME_CHARS);
  return clean.length > 0 ? clean : "file";
}

/**
 * `attachment`, with the name quoted in plain ASCII. A stored name is already limited to ASCII when the file is saved
 * (see `safeFileName`), so there is no second, exact spelling to send beside it.
 */
function downloadDisposition(name: string): string {
  return `attachment; filename="${headerName(name)}"`;
}

/**
 * The response headers for a stored attachment. A passive raster is shown inline, for the thread's thumbnails and
 * lightbox. SVG keeps its type, so an `<img>` still draws it, but opened on its own it downloads. Everything else is
 * opaque bytes to download. No cross-origin resource policy is set: a page on an allowed origin loads these in an `<img>`.
 */
export function attachmentHeaders(record: { name: string; mediaType: string }, length: number): Record<string, string> {
  const type = normalizeMediaType(record.mediaType);
  const common = {
    "content-length": String(length),
    "cache-control": "private, max-age=86400",
    "x-content-type-options": "nosniff",
    "content-security-policy": SANDBOX_CSP,
  };
  if (PASSIVE_IMAGES.has(type)) {
    return { ...common, "content-type": type, "content-disposition": "inline" };
  }
  const disposition = downloadDisposition(record.name);
  if (type === "image/svg+xml") {
    return { ...common, "content-type": type, "content-disposition": disposition };
  }
  return { ...common, "content-type": OPAQUE_MEDIA_TYPE, "content-disposition": disposition };
}
