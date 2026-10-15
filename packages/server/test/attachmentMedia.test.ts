/** Media types as stored and as served: one clean lower-case type, and headers that keep a stored file inert. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachmentHeaders, normalizeMediaType } from "../src/attachments.js";

describe("normalizeMediaType", () => {
  it("lower-cases, drops parameters and trims", () => {
    assert.equal(normalizeMediaType("image/png"), "image/png");
    assert.equal(normalizeMediaType("  IMAGE/PNG ; charset=binary"), "image/png");
    assert.equal(normalizeMediaType("Text/HTML; charset=utf-8"), "text/html");
    assert.equal(normalizeMediaType("IMAGE/SVG+XML"), "image/svg+xml");
    assert.equal(normalizeMediaType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("maps the spellings of jpeg and png that browsers and old files use", () => {
    for (const alias of ["image/jpg", "IMAGE/JPG", "image/pjpeg", "image/jpeg"]) {
      assert.equal(normalizeMediaType(alias), "image/jpeg", alias);
    }
    assert.equal(normalizeMediaType("image/x-png"), "image/png");
  });

  it("turns anything that is not a plain type into an opaque one", () => {
    const hostile = [
      "",
      "   ",
      "png",
      "image/",
      "/png",
      "image/png\r\nX-Evil: 1",
      "image/png\nSet-Cookie: a=b",
      "text/ht ml",
      "image/png,image/svg+xml",
      `text/${"a".repeat(25_000)}`,
      "image/\u0000png",
    ];
    for (const value of hostile) {
      assert.equal(normalizeMediaType(value), "application/octet-stream", JSON.stringify(value.slice(0, 40)));
    }
    for (const value of [undefined, null, 5, {}, ["image/png"]]) {
      assert.equal(normalizeMediaType(value), "application/octet-stream");
    }
  });
});

describe("attachmentHeaders", () => {
  const record = (mediaType: string, name = "file.bin") => ({ name, mediaType });

  it("shows a passive raster inline", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/heic", "image/heif", "image/tiff", "image/jxl"]) {
      const headers = attachmentHeaders(record(type, "pic"), 12);
      assert.equal(headers["content-type"], type);
      assert.equal(headers["content-disposition"], "inline");
      assert.equal(headers["content-length"], "12");
      assert.equal(headers["x-content-type-options"], "nosniff");
      assert.match(headers["content-security-policy"] ?? "", /^sandbox\b/);
      assert.equal(headers["cache-control"], "private, max-age=86400");
    }
  });

  it("serves svg as svg but only ever as a download", () => {
    const headers = attachmentHeaders(record("IMAGE/SVG+XML", "logo.svg"), 3);
    assert.equal(headers["content-type"], "image/svg+xml");
    assert.equal(headers["content-disposition"], 'attachment; filename="logo.svg"');
  });

  it("serves every other type as opaque bytes to download", () => {
    for (const type of ["text/html", "application/xhtml+xml", "text/xml", "application/xml", "application/pdf", "text/plain", "image/png\r\nX: y"]) {
      const headers = attachmentHeaders(record(type, "x.dat"), 1);
      assert.equal(headers["content-type"], "application/octet-stream", type);
      assert.match(headers["content-disposition"] ?? "", /^attachment\b/, type);
    }
  });

  it("never lets a stored name break out of the header", () => {
    const headers = attachmentHeaders(record("text/plain", 'a"b\r\nSet-Cookie: x.txt'), 1);
    assert.ok(!/[\r\n]/.test(headers["content-disposition"] ?? ""));
    assert.match(headers["content-disposition"] ?? "", /^attachment; filename="[A-Za-z0-9._-]+"$/);
  });

  it("falls back to a quoted ASCII name for letters a header cannot carry, and sends no second spelling", () => {
    const headers = attachmentHeaders(record("application/pdf", "relatório final.pdf"), 1);
    assert.equal(headers["content-disposition"], 'attachment; filename="relat-rio-final.pdf"');
    assert.ok(!(headers["content-disposition"] ?? "").includes("filename*"));
  });

  it("does not throw on a name that is not valid text", () => {
    const headers = attachmentHeaders(record("text/plain", "bad\ud800name.txt"), 1);
    assert.match(headers["content-disposition"] ?? "", /^attachment; filename="[A-Za-z0-9._-]+"$/);
  });

  it("sends the plain name alone when the name is already plain", () => {
    assert.equal(attachmentHeaders(record("text/plain", "notes.txt"), 1)["content-disposition"], 'attachment; filename="notes.txt"');
  });

  it("does not ask for a same-origin resource policy, which would hide an image from an allowed origin", () => {
    assert.equal(attachmentHeaders(record("image/png"), 1)["cross-origin-resource-policy"], undefined);
  });
});
