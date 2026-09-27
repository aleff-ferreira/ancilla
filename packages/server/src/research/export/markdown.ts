/**
 * The report as a document: GitHub-flavoured Markdown parsed to mdast, with the citations picked out.
 *
 * A report cites its sources as GFM footnotes: `[^3]` inline and, under a `## Sources` heading at the end, one
 * definition per line, `[^3]: [Title](https://url)`. Every renderer works from the same split: the body without the
 * definitions (and without the now-empty Sources heading), plus a numbered list of sources each renderer lays out in
 * its own way. Older reports cite with bare `[3]` and list `[3] Title (https://url)`; they are brought to the footnote
 * form before parsing.
 */
import type { FootnoteDefinition, Nodes, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export interface ReportMeta {
  /** The run's question: the document's title. */
  question: string;
  /** When the run ended, ISO; null for a report from a run without an end stamp. */
  endedAt: string | null;
}

export interface ReportSource {
  /** The footnote identifier as the report spelled it (normalised by the parser): `3` for `[^3]`. */
  id: string;
  /** Its number in the rendered Sources list, 1-based, in order of first citation. */
  number: number;
  /** The source's title, or its URL when the definition names only that. */
  title: string;
  url: string | null;
}

export interface SplitReport {
  /** The report's blocks without footnote definitions and without a Sources heading left with nothing under it. */
  body: RootContent[];
  /** Every source, in the order their numbers run. */
  sources: ReportSource[];
  /** A footnote identifier's number in `sources`. */
  numberOf: Map<string, number>;
}

const SOURCES_HEADING = /^#{1,3}\s+(?:Sources|References)\s*$/i;
/** `[3] Title (https://url)`, `[3] https://url` or `3. Title (https://url)`: the shapes older reports listed sources in. */
const OLD_SOURCE_LINE = /^(?:\[(\d+)\]|(\d+)\.)\s+(.*?)\s*$/;
const TRAILING_URL = /^(.*?)\s*\(?\s*(https?:\/\/[^\s()<>]+)\s*\)?$/;

/**
 * Rewrites a report that cites with bare `[3]` and lists `[3] Title (https://url)` under its Sources heading to the
 * footnote form (`[^3]` and `[^3]: [Title](https://url)`), so it exports with linked citations like a newer one.
 * A report already in the footnote form, or without a Sources section, comes back as it was.
 *
 * TODO(merge): the daemon on main exports `modernizeCitations` from `@ancilla/daemon` (research/citations.ts); this
 * copy exists only because the worktree this was built in predates it. Import the daemon's and drop this one.
 */
export function modernizeCitations(report: string): string {
  const lines = report.replace(/\r\n?/g, "\n").split("\n");
  let headingAt = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (SOURCES_HEADING.test(lines[i] as string)) {
      headingAt = i;
      break;
    }
  }
  if (headingAt < 0) {
    return report;
  }
  const numbers = new Set<string>();
  const rewrittenSources = lines.slice(headingAt + 1).map((line) => {
    const match = OLD_SOURCE_LINE.exec(line.trim());
    if (!match) {
      return line;
    }
    const number = (match[1] ?? match[2]) as string;
    const located = TRAILING_URL.exec((match[3] ?? "").trim());
    if (!located) {
      return line;
    }
    const url = located[2] as string;
    const title = (located[1] as string).trim().replace(/[\s:–-]+$/, "").replace(/[[\]]/g, "") || url;
    numbers.add(number);
    return `[^${number}]: [${title}](${url})`;
  });
  if (numbers.size === 0) {
    return report;
  }
  const body = lines
    .slice(0, headingAt)
    .join("\n")
    // `[3]` that is a citation: not already a footnote, not the text of a link `[3](url)` nor a reference `[3]: url`.
    .replace(/\[(\d+)\](?![(:])/g, (whole, number: string) => (numbers.has(number) ? `[^${number}]` : whole));
  return [body, lines[headingAt], ...rewrittenSources].join("\n");
}

/** The report's Markdown as mdast, with GFM tables, footnotes, strikethrough and task lists. */
export function parseReport(markdown: string): Root {
  return fromMarkdown(modernizeCitations(markdown), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** The text of a node and everything under it; images stand in as their alt text. */
export function plainText(node: Nodes | Nodes[] | undefined): string {
  if (!node) {
    return "";
  }
  if (Array.isArray(node)) {
    return node.map((child) => plainText(child)).join("");
  }
  if (node.type === "image" || node.type === "imageReference") {
    return node.alt ?? "";
  }
  if (node.type === "break") {
    return "\n";
  }
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  if ("children" in node) {
    return plainText(node.children as Nodes[]);
  }
  return "";
}

/** Every node of one type under `root`, in document order. */
export function collect<T extends Nodes["type"]>(root: Nodes, type: T): Extract<Nodes, { type: T }>[] {
  const found: Extract<Nodes, { type: T }>[] = [];
  const visit = (node: Nodes): void => {
    if (node.type === type) {
      found.push(node as Extract<Nodes, { type: T }>);
    }
    if ("children" in node) {
      for (const child of node.children as Nodes[]) {
        visit(child);
      }
    }
  };
  visit(root);
  return found;
}

/** A source's title and URL from its definition: the first link, else `Title (url)` or a bare URL in the text. */
function sourceOf(definition: FootnoteDefinition): { title: string; url: string | null } {
  const link = collect(definition, "link")[0];
  if (link) {
    const title = plainText(link.children).trim();
    return { title: title || link.url, url: link.url };
  }
  const text = plainText(definition.children).trim();
  const located = TRAILING_URL.exec(text);
  if (located) {
    const url = located[2] as string;
    const title = (located[1] as string).trim().replace(/[\s:–-]+$/, "");
    return { title: title || url, url };
  }
  return { title: text || definition.label || definition.identifier, url: null };
}

/**
 * Splits a parsed report into its body and its sources. Sources are numbered in the order the body first cites
 * them, with definitions nothing cites appended in the order they were written, so a rendered `2` always jumps to
 * the second entry of the list.
 */
export function splitReport(root: Root): SplitReport {
  const definitions = new Map<string, FootnoteDefinition>();
  for (const definition of collect(root, "footnoteDefinition")) {
    if (!definitions.has(definition.identifier)) {
      definitions.set(definition.identifier, definition);
    }
  }
  const order: string[] = [];
  for (const reference of collect(root, "footnoteReference")) {
    if (definitions.has(reference.identifier) && !order.includes(reference.identifier)) {
      order.push(reference.identifier);
    }
  }
  for (const id of definitions.keys()) {
    if (!order.includes(id)) {
      order.push(id);
    }
  }
  const numberOf = new Map<string, number>();
  const sources = order.map((id, index) => {
    numberOf.set(id, index + 1);
    return { id, number: index + 1, ...sourceOf(definitions.get(id) as FootnoteDefinition) };
  });

  const body = stripDefinitions(root.children);
  // The Sources heading the definitions sat under now heads nothing; each renderer adds its own.
  const last = body[body.length - 1];
  if (last && last.type === "heading" && /^(?:Sources|References)$/i.test(plainText(last.children).trim())) {
    body.pop();
  }
  return { body, sources, numberOf };
}

function stripDefinitions(nodes: RootContent[]): RootContent[] {
  const kept: RootContent[] = [];
  for (const node of nodes) {
    if (node.type === "footnoteDefinition") {
      continue;
    }
    if ("children" in node && Array.isArray(node.children)) {
      kept.push({ ...node, children: stripDefinitions(node.children as RootContent[]) } as RootContent);
    } else {
      kept.push(node);
    }
  }
  return kept;
}

/** The line every rendering carries under its title. */
export function subtitleOf(meta: ReportMeta): string {
  const date = meta.endedAt && /^\d{4}-\d{2}-\d{2}/.test(meta.endedAt) ? meta.endedAt.slice(0, 10) : null;
  return ["Deep research report", "Ancilla", ...(date ? [date] : [])].join(" · ");
}
