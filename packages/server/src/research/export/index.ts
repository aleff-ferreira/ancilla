/**
 * Exporting a DeepResearch report: the report's Markdown rendered to PDF, DOCX or HTML, saved beside report.md and
 * served back as a download. The server routes (`POST /api/research/:runId/export`, `GET .../export/:name`) live in
 * server.ts and call in here; everything here is free of the store and the server so it can be tested on its own.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { renderDocx } from "./docx.js";
import { renderHtml } from "./html.js";
import { type ReportMeta, parseReport } from "./markdown.js";
import { renderPdf } from "./pdf.js";

export { docxAnchor, renderDocx } from "./docx.js";
export { renderHtml } from "./html.js";
export { collect, parseReport, plainText, splitReport, subtitleOf } from "./markdown.js";
export type { ReportMeta, ReportSource, SplitReport } from "./markdown.js";
export { renderPdf, toWinAnsi } from "./pdf.js";

export type ExportFormat = "pdf" | "docx" | "html";

export const EXPORT_FORMATS: readonly ExportFormat[] = ["pdf", "docx", "html"];

export const EXPORT_MEDIA_TYPES: Record<ExportFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html; charset=utf-8",
};

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value);
}

/** The file an export is saved as, beside report.md. */
export function exportFileName(format: ExportFormat): string {
  return `report.${format}`;
}

/** The format an export file's name stands for, or null for a name that is not one of ours. */
export function exportFormatOfName(name: string): ExportFormat | null {
  const match = /^report\.(pdf|docx|html)$/.exec(name);
  return match ? (match[1] as ExportFormat) : null;
}

/** The download's file name stem: the question, lowercased, runs of anything but letters and digits as one dash. */
export function questionSlug(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "report";
}

/** The report's Markdown rendered in one format. */
export async function renderReport(format: ExportFormat, markdown: string, meta: ReportMeta): Promise<Buffer> {
  const root = parseReport(markdown);
  switch (format) {
    case "pdf":
      return renderPdf(root, meta);
    case "docx":
      return renderDocx(root, meta);
    case "html":
      return Buffer.from(renderHtml(root, meta), "utf8");
  }
}

/** Sends a generated export as an attachment named after the question. */
export async function serveExportFile(req: IncomingMessage, res: ServerResponse, abs: string, format: ExportFormat, fileName: string): Promise<void> {
  const info = await stat(abs);
  res.writeHead(200, {
    "content-type": EXPORT_MEDIA_TYPES[format],
    "content-length": String(info.size),
    "content-disposition": `attachment; filename="${fileName}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(abs).pipe(res);
}
