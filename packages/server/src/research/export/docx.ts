/**
 * The report as a Word document, through `docx`: real hyperlinks for links and sources, Word bookmarks on the Sources
 * entries and internal hyperlinks from the superscript citations to them, Word's own list numbering, tables, and
 * "Page n of N" in the footer.
 */
import type { List, PhrasingContent, Root, RootContent, Table as MdTable } from "mdast";
import {
  AlignmentType,
  Bookmark,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  InternalHyperlink,
  LevelFormat,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type IRunOptions,
  type ParagraphChild,
} from "docx";
import { type ReportMeta, type ReportSource, plainText, splitReport, subtitleOf } from "./markdown.js";

const BODY_FONT = "Calibri";
const MONO_FONT = "Consolas";
const MUTED = "59636E";
const RULE = "D1D9E0";
const CODE_FILL = "F3F4F6";
/** Word's list indent per level, in twentieths of a point (half an inch). */
const LEVEL_INDENT = 720;
const MAX_LEVEL = 8;
const BULLETS = ["•", "◦", "▪"];

interface InlineStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  link?: boolean;
}

interface BlockContext {
  /** The list a paragraph is the first line of, if any. */
  numbering?: { reference: string; level: number; instance: number };
  /** Nesting depth of the surrounding lists, for paragraphs that follow the first inside an item. */
  level: number;
  quote: boolean;
}

/** A Word bookmark name: letters, digits and underscores, starting with a letter. */
export function docxAnchor(number: number): string {
  return `src_${number}`;
}

type Block = Paragraph | Table;

class DocxBuilder {
  private instances = 0;

  constructor(private readonly numberOf: Map<string, number>) {}

  /** Every list numbers from one: each gets its own numbering instance. */
  private nextInstance(): number {
    this.instances += 1;
    return this.instances;
  }

  runs(nodes: PhrasingContent[], style: InlineStyle = {}): ParagraphChild[] {
    const out: ParagraphChild[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case "text":
          out.push(this.run(node.value.replace(/\n/g, " "), style));
          break;
        case "strong":
          out.push(...this.runs(node.children, { ...style, bold: true }));
          break;
        case "emphasis":
          out.push(...this.runs(node.children, { ...style, italics: true }));
          break;
        case "delete":
          out.push(...this.runs(node.children, { ...style, strike: true }));
          break;
        case "inlineCode":
          out.push(new TextRun({ ...this.runOptions(style), text: node.value, font: MONO_FONT, shading: { type: ShadingType.CLEAR, fill: CODE_FILL } }));
          break;
        case "break":
          out.push(new TextRun({ break: 1 }));
          break;
        case "link":
          out.push(new ExternalHyperlink({ link: node.url, children: this.runs(node.children, { ...style, link: true }) }));
          break;
        case "linkReference":
          out.push(...this.runs(node.children, style));
          break;
        case "image":
        case "imageReference":
          if (node.alt) {
            out.push(this.run(node.alt, { ...style, italics: true }));
          }
          break;
        case "footnoteReference": {
          const number = this.numberOf.get(node.identifier);
          if (number === undefined) {
            out.push(this.run(`[^${node.label ?? node.identifier}]`, style));
          } else {
            out.push(new InternalHyperlink({ anchor: docxAnchor(number), children: [new TextRun({ text: String(number), superScript: true, style: "Hyperlink" })] }));
          }
          break;
        }
        case "html":
          break;
        default:
          out.push(this.run(plainText(node as PhrasingContent), style));
      }
    }
    return out;
  }

  private runOptions(style: InlineStyle): IRunOptions {
    return {
      bold: style.bold,
      italics: style.italics,
      strike: style.strike,
      style: style.link ? "Hyperlink" : undefined,
    };
  }

  private run(text: string, style: InlineStyle): TextRun {
    return new TextRun({ ...this.runOptions(style), text });
  }

  blocks(nodes: RootContent[], context: BlockContext): Block[] {
    const out: Block[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case "heading":
          out.push(new Paragraph({ heading: HEADINGS[Math.min(node.depth, 6) - 1], children: this.runs(node.children) }));
          break;
        case "paragraph":
          out.push(new Paragraph({ ...this.paragraphOptions(context), children: this.runs(node.children) }));
          break;
        case "list":
          out.push(...this.list(node, context));
          break;
        case "blockquote":
          out.push(...this.blocks(node.children, { ...context, quote: true }));
          break;
        case "code":
          out.push(this.codeBlock(node.value, context));
          break;
        case "table":
          out.push(this.table(node));
          break;
        case "thematicBreak":
          out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 1 } }, spacing: { before: 240, after: 240 } }));
          break;
        case "html":
        case "definition":
        case "footnoteDefinition":
        case "yaml":
          break;
        default:
          if ("children" in node) {
            out.push(new Paragraph({ ...this.paragraphOptions(context), children: this.runs(node.children as PhrasingContent[]) }));
          }
      }
    }
    return out;
  }

  private paragraphOptions(context: BlockContext): IParagraphOptions {
    const options: Record<string, unknown> = { spacing: { after: 160 } };
    if (context.numbering) {
      options["numbering"] = context.numbering;
    } else if (context.level > 0) {
      options["indent"] = { left: LEVEL_INDENT * context.level };
    }
    if (context.quote) {
      options["border"] = { left: { style: BorderStyle.SINGLE, size: 18, color: RULE, space: 12 } };
      options["indent"] = { left: LEVEL_INDENT * context.level + 360 };
    }
    return options as IParagraphOptions;
  }

  private list(node: List, context: BlockContext): Block[] {
    const out: Block[] = [];
    const reference = node.ordered ? "numbered" : "bullets";
    const instance = this.nextInstance();
    const level = Math.min(context.level, MAX_LEVEL);
    for (const item of node.children) {
      const numbering = { reference, level, instance };
      const [first, ...rest] = item.children;
      const marker = item.checked === null || item.checked === undefined ? "" : item.checked ? "☑ " : "☐ ";
      if (!first || first.type !== "paragraph") {
        // An item that starts with a nested list or a code block still needs a line to hang its number on.
        out.push(new Paragraph({ ...this.paragraphOptions({ ...context, numbering }), children: marker ? [new TextRun(marker)] : [] }));
        out.push(...this.blocks(first ? [first, ...rest] : [], { ...context, numbering: undefined, level: level + 1 }));
        continue;
      }
      const children = this.runs(first.children);
      out.push(new Paragraph({ ...this.paragraphOptions({ ...context, numbering }), children: marker ? [new TextRun(marker), ...children] : children }));
      out.push(...this.blocks(rest, { ...context, numbering: undefined, level: level + 1 }));
    }
    return out;
  }

  private codeBlock(value: string, context: BlockContext): Paragraph {
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    const children: ParagraphChild[] = [];
    lines.forEach((line, index) => {
      if (index > 0) {
        children.push(new TextRun({ break: 1 }));
      }
      children.push(new TextRun({ text: line, font: MONO_FONT, size: 18 }));
    });
    const border = { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 6 };
    return new Paragraph({
      children,
      shading: { type: ShadingType.CLEAR, fill: CODE_FILL },
      border: { top: border, bottom: border, left: border, right: border },
      indent: context.level > 0 ? { left: LEVEL_INDENT * context.level } : undefined,
      spacing: { before: 120, after: 200, line: 264 },
    });
  }

  private table(node: MdTable): Table {
    const rows = node.children.map((row, rowIndex) => {
      const cells = row.children.map((cell, cellIndex) => {
        const align = node.align?.[cellIndex];
        const alignment = align === "center" ? AlignmentType.CENTER : align === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT;
        const runs = this.runs(cell.children, rowIndex === 0 ? { bold: true } : {});
        return new TableCell({
          children: [new Paragraph({ alignment, children: runs, spacing: { after: 0 } })],
          shading: rowIndex === 0 ? { type: ShadingType.CLEAR, fill: CODE_FILL } : undefined,
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
        });
      });
      return new TableRow({ children: cells, tableHeader: rowIndex === 0 });
    });
    return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
  }

  sources(sources: ReportSource[]): Block[] {
    if (sources.length === 0) {
      return [];
    }
    const instance = this.nextInstance();
    const out: Block[] = [new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("Sources")] })];
    for (const source of sources) {
      const title = source.url
        ? new ExternalHyperlink({ link: source.url, children: [new TextRun({ text: source.title, style: "Hyperlink" })] })
        : new TextRun(source.title);
      const children: ParagraphChild[] = [new Bookmark({ id: docxAnchor(source.number), children: [title] })];
      if (source.url) {
        children.push(new TextRun({ text: ` ${source.url}`, color: MUTED, size: 18 }));
      }
      out.push(new Paragraph({ numbering: { reference: "sources", level: 0, instance }, spacing: { after: 100 }, children }));
    }
    return out;
  }
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6] as const;

function levels(format: (typeof LevelFormat)[keyof typeof LevelFormat], text: (level: number) => string) {
  return Array.from({ length: MAX_LEVEL + 1 }, (_, level) => ({
    level,
    format,
    text: text(level),
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: LEVEL_INDENT * (level + 1), hanging: 360 } } },
  }));
}

function heading(id: string, name: string, size: number, before: number): { id: string; name: string; basedOn: string; next: string; quickFormat: boolean; run: IRunOptions; paragraph: { spacing: { before: number; after: number } } } {
  return { id, name, basedOn: "Normal", next: "Normal", quickFormat: true, run: { size, bold: true, font: BODY_FONT, color: "1F2328" }, paragraph: { spacing: { before, after: 120 } } };
}

/** The report as a .docx file. */
export async function renderDocx(root: Root, meta: ReportMeta): Promise<Buffer> {
  const { body, sources, numberOf } = splitReport(root);
  const builder = new DocxBuilder(numberOf);
  const question = meta.question.trim() || "Research report";
  const document = new Document({
    creator: "Ancilla",
    title: question,
    description: subtitleOf(meta),
    styles: {
      default: { document: { run: { font: BODY_FONT, size: 22 } } },
      paragraphStyles: [
        { id: "Title", name: "Title", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 44, bold: true, font: BODY_FONT }, paragraph: { spacing: { after: 120 } } },
        heading("Heading1", "Heading 1", 32, 360),
        heading("Heading2", "Heading 2", 28, 320),
        heading("Heading3", "Heading 3", 25, 280),
        heading("Heading4", "Heading 4", 23, 240),
        heading("Heading5", "Heading 5", 22, 240),
        heading("Heading6", "Heading 6", 22, 240),
      ],
    },
    numbering: {
      config: [
        { reference: "bullets", levels: levels(LevelFormat.BULLET, (level) => BULLETS[level % BULLETS.length] as string) },
        { reference: "numbered", levels: levels(LevelFormat.DECIMAL, (level) => `%${level + 1}.`) },
        { reference: "sources", levels: levels(LevelFormat.DECIMAL, (level) => `%${level + 1}.`) },
      ],
    },
    sections: [
      {
        properties: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], color: MUTED, size: 18 })],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(question)] }),
          new Paragraph({
            children: [new TextRun({ text: subtitleOf(meta), color: MUTED, size: 20 })],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 8 } },
            spacing: { after: 360 },
          }),
          ...builder.blocks(body, { level: 0, quote: false }),
          ...builder.sources(sources),
        ],
      },
    ],
  });
  return Packer.toBuffer(document);
}
