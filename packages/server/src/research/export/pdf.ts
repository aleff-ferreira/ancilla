/**
 * The report as a PDF, through pdfkit: the body laid out block by block with Helvetica and Courier, URLs as link
 * annotations, superscript citations as GoTo annotations onto named destinations at the Sources entries, and
 * "Page n of N" stamped into every footer once the page count is known.
 *
 * Fonts. The document uses pdfkit's built-in Type 1 fonts (Helvetica, its bold and oblique cuts, and Courier), which
 * ship with pdfkit and need no file on disk, but they only carry the WinAnsi (CP1252) repertoire: ASCII, accented
 * Latin, curly quotes, dashes, the bullet and the ellipsis. Anything else (Greek, Cyrillic, CJK, emoji, arrows,
 * mathematical symbols) has no glyph, so `toWinAnsi` swaps such characters for their closest ASCII spelling or a `?`
 * rather than letting pdfkit write an undefined byte. Embedding a Unicode TrueType font would lift the limit at the
 * cost of shipping the font file.
 */
import PDFDocument from "pdfkit";
import type { Blockquote, Code, Heading, List, PhrasingContent, Root, RootContent, Table } from "mdast";
import { type ReportMeta, type ReportSource, type SplitReport, headingOf, plainText, splitReport, subtitleOf } from "./markdown.js";

const FONT = { regular: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique", boldItalic: "Helvetica-BoldOblique", mono: "Courier" } as const;
const COLOR = { text: "#1f2328", muted: "#59636e", link: "#0969da", rule: "#d1d9e0", codeBg: "#f3f4f6" } as const;
const PAGE_MARGIN = 56;
const BODY_SIZE = 10.5;
const LINE_GAP = 2.5;
const HEADING_SIZES = [20, 15.5, 13, 11.5, 10.5, 10.5];
const LIST_INDENT = 18;
const QUOTE_INDENT = 14;
/** Helvetica's ascender, in thousandths of the font size. */
const ASCENDER = 0.718;

/** Characters outside Latin-1 that WinAnsi does have, at 0x80-0x9F. */
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
/** Common characters WinAnsi lacks, spelled the way a typewriter would. */
const ASCII_STAND_INS: Record<string, string> = {
  "‐": "-", "‑": "-", "‒": "-", "―": "-", "−": "-", "⁃": "-",
  "′": "'", "″": '"', "‵": "'", "‶": '"', "‛": "'", "‟": '"',
  "←": "<-", "→": "->", "↔": "<->", "⇐": "<=", "⇒": "=>", "⇔": "<=>",
  "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "×": "×", "∕": "/", "∗": "*", "∞": "inf",
  "✓": "v", "✔": "v", "✗": "x", "✘": "x", "★": "*", "☆": "*", "●": "•", "◦": "-", "▪": "-", "▫": "-", "‣": "-",
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", "　": " ",
  "​": "", "‌": "", "‍": "", "⁠": "", "﻿": "", "︎": "", "️": "",
  "ﬁ": "fi", "ﬂ": "fl", "№": "No.", "℃": "°C", "℉": "°F",
};

function isWinAnsi(char: string): boolean {
  const code = char.codePointAt(0) as number;
  return (code >= 0x20 && code <= 0x7e) || code === 0x0a || code === 0x09 || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(char);
}

/** `text` with every character pdfkit's standard fonts cannot encode replaced (see the module comment). */
export function toWinAnsi(text: string): string {
  let out = "";
  for (const char of text) {
    if (isWinAnsi(char)) {
      out += char;
      continue;
    }
    const standIn = ASCII_STAND_INS[char];
    if (standIn !== undefined) {
      out += standIn;
      continue;
    }
    // A letter with a diacritic WinAnsi lacks (ő, ș, ǎ) keeps its base letter; a combining mark on its own is dropped.
    const stripped = char.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    if (stripped.length > 0 && [...stripped].every(isWinAnsi)) {
      out += stripped;
      continue;
    }
    if (/\p{M}/u.test(char)) {
      continue;
    }
    out += "?";
  }
  return out;
}

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  strike: boolean;
  link: string | null;
  goTo: string | null;
  sup: boolean;
}

type Style = Pick<Run, "bold" | "italic" | "mono" | "strike">;

const PLAIN: Style = { bold: false, italic: false, mono: false, strike: false };

function fontFor(run: Style): string {
  if (run.mono) {
    return FONT.mono;
  }
  if (run.bold && run.italic) {
    return FONT.boldItalic;
  }
  if (run.bold) {
    return FONT.bold;
  }
  if (run.italic) {
    return FONT.italic;
  }
  return FONT.regular;
}

interface Frame {
  /** The left edge of the current block. */
  x: number;
  /** How wide the block may run. */
  width: number;
  color: string;
}

class PdfBuilder {
  readonly doc: PDFKit.PDFDocument;
  private readonly left: number;
  private readonly contentWidth: number;

  constructor(private readonly numberOf: Map<string, number>, title: string, meta: ReportMeta) {
    this.doc = new PDFDocument({
      size: "A4",
      margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN + 12, left: PAGE_MARGIN, right: PAGE_MARGIN },
      bufferPages: true,
      autoFirstPage: true,
      info: { Title: title, Author: "Ancilla", Subject: subtitleOf(meta), Creator: "Ancilla" },
      pdfVersion: "1.5",
    });
    this.left = this.doc.page.margins.left;
    this.contentWidth = this.doc.page.width - this.doc.page.margins.left - this.doc.page.margins.right;
  }

  private frame(indent = 0, color: string = COLOR.text): Frame {
    return { x: this.left + indent, width: this.contentWidth - indent, color };
  }

  /** Starts a new page when fewer than `needed` points remain, so a heading is never left alone at the bottom. */
  private ensure(needed: number): void {
    if (this.doc.y + needed > this.doc.page.height - this.doc.page.margins.bottom) {
      this.doc.addPage();
    }
  }

  // ------------------------------------------------------------------ inlines

  runs(nodes: PhrasingContent[], style: Style = PLAIN, into: Run[] = []): Run[] {
    for (const node of nodes) {
      switch (node.type) {
        case "text":
          into.push({ ...style, text: node.value.replace(/\n/g, " "), link: null, goTo: null, sup: false });
          break;
        case "strong":
          this.runs(node.children, { ...style, bold: true }, into);
          break;
        case "emphasis":
          this.runs(node.children, { ...style, italic: true }, into);
          break;
        case "delete":
          this.runs(node.children, { ...style, strike: true }, into);
          break;
        case "inlineCode":
          into.push({ ...style, mono: true, text: node.value, link: null, goTo: null, sup: false });
          break;
        case "break":
          into.push({ ...style, text: "\n", link: null, goTo: null, sup: false });
          break;
        case "link": {
          const inner = this.runs(node.children, style, []);
          for (const run of inner) {
            into.push({ ...run, link: node.url });
          }
          break;
        }
        case "linkReference":
          this.runs(node.children, style, into);
          break;
        case "image":
        case "imageReference":
          if (node.alt) {
            into.push({ ...style, italic: true, text: node.alt, link: null, goTo: null, sup: false });
          }
          break;
        case "footnoteReference": {
          const number = this.numberOf.get(node.identifier);
          if (number === undefined) {
            into.push({ ...style, text: `[^${node.label ?? node.identifier}]`, link: null, goTo: null, sup: false });
          } else {
            into.push({ ...PLAIN, text: String(number), link: null, goTo: destinationOf(number), sup: true });
          }
          break;
        }
        case "html":
          break;
        default:
          into.push({ ...style, text: plainText(node as PhrasingContent), link: null, goTo: null, sup: false });
      }
    }
    return into;
  }

  /** Writes runs as one wrapped paragraph starting at the frame's left edge. */
  writeRuns(runs: Run[], frame: Frame, size = BODY_SIZE, paragraphGap = 6): void {
    const kept = runs.filter((run) => run.text.length > 0);
    if (kept.length === 0) {
      this.doc.moveDown(0.5);
      return;
    }
    this.doc.x = frame.x;
    kept.forEach((run, index) => {
      const last = index === kept.length - 1;
      const active = run.link !== null || run.goTo !== null;
      const runSize = run.sup ? size * 0.65 : run.mono ? size * 0.92 : size;
      this.doc.font(fontFor(run)).fontSize(runSize).fillColor(active ? COLOR.link : frame.color);
      // Every option is set outright: pdfkit carries an option a continued run leaves undefined over from the run
      // before it, which would stretch a citation's jump or a link's underline across the rest of the paragraph.
      this.doc.text(toWinAnsi(run.text), {
        width: frame.width,
        continued: !last,
        lineGap: LINE_GAP,
        paragraphGap: last ? paragraphGap : 0,
        link: run.link,
        goTo: run.goTo ?? null,
        underline: run.link !== null,
        strike: run.strike,
        // A superscript sits on a raised baseline: the body's ascender height less a third of the body size.
        baseline: run.sup ? -(ASCENDER * size - size * 0.33) : "top",
      } as PDFKit.Mixins.TextOptions);
    });
    this.doc.fillColor(COLOR.text);
  }

  // ------------------------------------------------------------------ blocks

  blocks(nodes: RootContent[], indent = 0, color: string = COLOR.text): void {
    for (const node of nodes) {
      switch (node.type) {
        case "heading":
          this.heading(node, indent);
          break;
        case "paragraph":
          this.writeRuns(this.runs(node.children), this.frame(indent, color));
          break;
        case "list":
          this.list(node, indent, color);
          break;
        case "blockquote":
          this.blockquote(node, indent);
          break;
        case "code":
          this.code(node, indent);
          break;
        case "table":
          this.table(node, indent);
          break;
        case "thematicBreak":
          this.rule(indent);
          break;
        case "html":
        case "definition":
        case "footnoteDefinition":
        case "yaml":
          break;
        default:
          if ("children" in node) {
            this.writeRuns(this.runs(node.children as PhrasingContent[]), this.frame(indent, color));
          }
      }
    }
  }

  private heading(node: Heading, indent: number): void {
    const size = HEADING_SIZES[Math.min(node.depth, 6) - 1] as number;
    this.ensure(size * 4);
    this.doc.moveDown(node.depth <= 2 ? 0.9 : 0.6);
    const runs = this.runs(node.children).map((run) => ({ ...run, bold: !run.mono }));
    this.writeRuns(runs, this.frame(indent), size, 3);
  }

  private list(node: List, indent: number, color: string): void {
    const start = node.start ?? 1;
    node.children.forEach((item, index) => {
      const marker = node.ordered ? `${start + index}.` : indent === 0 ? "•" : "–";
      const check = item.checked === null || item.checked === undefined ? "" : item.checked ? "[x] " : "[ ] ";
      const [first, ...rest] = item.children;
      this.ensure(BODY_SIZE * 2);
      const y = this.doc.y;
      this.doc.font(FONT.regular).fontSize(BODY_SIZE).fillColor(color);
      this.doc.text(toWinAnsi(marker), this.left + indent, y, { width: LIST_INDENT, lineBreak: false, lineGap: LINE_GAP });
      this.doc.y = y;
      const inner = indent + LIST_INDENT;
      if (first && first.type === "paragraph") {
        const runs = this.runs(first.children);
        if (check) {
          runs.unshift({ ...PLAIN, text: check, link: null, goTo: null, sup: false });
        }
        this.writeRuns(runs, this.frame(inner, color), BODY_SIZE, 2);
        this.blocks(rest, inner, color);
      } else {
        this.doc.x = this.left + inner;
        this.blocks(first ? [first, ...rest] : [], inner, color);
      }
    });
    this.doc.moveDown(0.35);
  }

  private blockquote(node: Blockquote, indent: number): void {
    const startPage = this.doc.bufferedPageRange().count;
    const startY = this.doc.y;
    this.blocks(node.children, indent + QUOTE_INDENT, COLOR.muted);
    // The bar is drawn only while the quote stays on the page it started on; a quote that runs over keeps its indent.
    const endPage = this.doc.bufferedPageRange().count;
    const endY = endPage === startPage ? this.doc.y - 4 : this.doc.page.height - this.doc.page.margins.bottom;
    if (endPage === startPage) {
      this.doc.save().rect(this.left + indent + 2, startY, 3, Math.max(0, endY - startY)).fill(COLOR.rule).restore();
    } else {
      const page = this.doc.bufferedPageRange();
      this.doc.switchToPage(page.start + startPage - 1);
      this.doc.save().rect(this.left + indent + 2, startY, 3, Math.max(0, endY - startY)).fill(COLOR.rule).restore();
      this.doc.switchToPage(page.start + endPage - 1);
    }
    this.doc.fillColor(COLOR.text);
  }

  private code(node: Code, indent: number): void {
    const size = 8.5;
    const padding = 8;
    const text = toWinAnsi(node.value.replace(/\r\n?/g, "\n").replace(/\t/g, "    "));
    const frame = this.frame(indent);
    this.doc.font(FONT.mono).fontSize(size);
    const height = this.doc.heightOfString(text, { width: frame.width - padding * 2, lineGap: 1 }) + padding * 2;
    const usable = this.doc.page.height - this.doc.page.margins.top - this.doc.page.margins.bottom;
    if (height < usable) {
      this.ensure(height);
      this.doc.save().roundedRect(frame.x, this.doc.y, frame.width, height, 3).fill(COLOR.codeBg).restore();
    }
    this.doc.fillColor(COLOR.text);
    this.doc.text(text, frame.x + padding, this.doc.y + padding, { width: frame.width - padding * 2, lineGap: 1 });
    this.doc.y += padding;
    this.doc.x = this.left;
    this.doc.moveDown(0.6);
  }

  private table(node: Table, indent: number): void {
    const frame = this.frame(indent);
    const data = node.children.map((row, rowIndex) =>
      row.children.map((cell, cellIndex) => {
        const align = node.align?.[cellIndex];
        return {
          text: toWinAnsi(plainText(cell.children)),
          font: { src: rowIndex === 0 ? FONT.bold : FONT.regular, size: 9 },
          align: { x: align === "center" ? "center" : align === "right" ? "right" : "left", y: "top" } as const,
          backgroundColor: rowIndex === 0 ? COLOR.codeBg : undefined,
          type: rowIndex === 0 ? ("TH" as const) : ("TD" as const),
        };
      }),
    );
    if (data.length === 0) {
      return;
    }
    this.ensure(BODY_SIZE * 4);
    this.doc.font(FONT.regular).fontSize(9).fillColor(COLOR.text);
    this.doc.table({
      position: { x: frame.x, y: this.doc.y },
      maxWidth: frame.width,
      data,
      defaultStyle: { border: 0.5, borderColor: COLOR.rule, padding: 4, textColor: COLOR.text },
    });
    this.doc.x = this.left;
    this.doc.moveDown(0.8);
  }

  private rule(indent: number): void {
    this.ensure(BODY_SIZE * 2);
    this.doc.moveDown(0.4);
    const frame = this.frame(indent);
    this.doc.save().moveTo(frame.x, this.doc.y).lineTo(frame.x + frame.width, this.doc.y).lineWidth(0.75).strokeColor(COLOR.rule).stroke().restore();
    this.doc.moveDown(0.8);
  }

  // ------------------------------------------------------------------ title and sources

  title(split: Pick<SplitReport, "title">, meta: ReportMeta): void {
    const heading = headingOf(split, meta);
    this.doc.font(FONT.bold).fontSize(22).fillColor(COLOR.text);
    this.doc.text(toWinAnsi(heading.title), this.left, this.doc.y, { width: this.contentWidth, lineGap: 3 });
    this.doc.moveDown(0.3);
    this.doc.font(FONT.regular).fontSize(9.5).fillColor(COLOR.muted);
    for (const line of heading.lines) this.doc.text(toWinAnsi(line), { width: this.contentWidth });
    this.doc.moveDown(0.5);
    this.doc.save().moveTo(this.left, this.doc.y).lineTo(this.left + this.contentWidth, this.doc.y).lineWidth(0.75).strokeColor(COLOR.rule).stroke().restore();
    this.doc.moveDown(0.8);
    this.doc.fillColor(COLOR.text);
  }

  sources(sources: ReportSource[]): void {
    if (sources.length === 0) {
      return;
    }
    this.heading({ type: "heading", depth: 2, children: [{ type: "text", value: "Sources" }] }, 0);
    const labelWidth = 24;
    for (const source of sources) {
      this.ensure(BODY_SIZE * 3);
      const y = this.doc.y;
      this.doc.font(FONT.regular).fontSize(BODY_SIZE).fillColor(COLOR.text);
      // The number carries the named destination the superscripts jump to.
      this.doc.text(`${source.number}.`, this.left, y, { width: labelWidth, lineBreak: false, destination: destinationOf(source.number) });
      this.doc.y = y;
      const frame = this.frame(labelWidth);
      const title: Run = { ...PLAIN, text: source.title, link: source.url, goTo: null, sup: false };
      this.writeRuns([title], frame, BODY_SIZE, 1);
      if (source.url) {
        this.doc.x = frame.x;
        this.doc.font(FONT.regular).fontSize(8.5).fillColor(COLOR.muted);
        this.doc.text(toWinAnsi(source.url), { width: frame.width, link: source.url, lineGap: 1, paragraphGap: 5 });
        this.doc.fillColor(COLOR.text);
      }
    }
  }

  /** "Page n of N" under every page; the bottom margin is lifted while stamping so pdfkit does not start a new page. */
  footers(): void {
    const range = this.doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      this.doc.switchToPage(index);
      const bottom = this.doc.page.margins.bottom;
      this.doc.page.margins.bottom = 0;
      this.doc.font(FONT.regular).fontSize(8.5).fillColor(COLOR.muted);
      this.doc.text(`Page ${index - range.start + 1} of ${range.count}`, this.left, this.doc.page.height - PAGE_MARGIN + 14, { width: this.contentWidth, align: "center", lineBreak: false });
      this.doc.page.margins.bottom = bottom;
    }
  }
}

function destinationOf(number: number): string {
  return `src-${number}`;
}

/** The report as a PDF. */
export function renderPdf(root: Root, meta: ReportMeta): Promise<Buffer> {
  const split = splitReport(root);
  const { body, sources, numberOf } = split;
  const builder = new PdfBuilder(numberOf, headingOf(split, meta).title, meta);
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    builder.doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    builder.doc.on("end", () => resolve(Buffer.concat(chunks)));
    builder.doc.on("error", reject);
    try {
      builder.title(split, meta);
      builder.blocks(body);
      builder.sources(sources);
      builder.footers();
      builder.doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
