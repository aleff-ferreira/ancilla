/**
 * The report as one standalone HTML file: the body through mdast-util-to-hast, citations as `<sup><a href="#src-3">`
 * pointing into an `<ol id="sources">`, and the stylesheet inline so the file reads the same wherever it is opened.
 */
import type { Element, ElementContent, Text } from "hast";
import { toHtml } from "hast-util-to-html";
import type { FootnoteReference, Image, ImageReference, Root } from "mdast";
import { type Handlers, type State, toHast } from "mdast-util-to-hast";
import { type ReportMeta, type ReportSource, headingOf, splitReport } from "./markdown.js";

const CSS = `
:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #ffffff; --rule: #d1d9e0; --code-bg: #f6f8fa; --link: #0969da; --quote: #d1d9e0; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6edf3; --muted: #9198a1; --bg: #0d1117; --rule: #30363d; --code-bg: #161b22; --link: #4493f8; --quote: #3d444d; }
}
html { background: var(--bg); }
body { margin: 0 auto; padding: 48px 24px 64px; max-width: 760px; color: var(--fg); background: var(--bg);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; overflow-wrap: anywhere; }
header { margin-bottom: 32px; border-bottom: 1px solid var(--rule); padding-bottom: 16px; }
header h1 { margin: 0 0 8px; font-size: 2em; line-height: 1.25; }
header .subtitle { color: var(--muted); font-size: 0.9em; margin: 0; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.6em; }
h1 { font-size: 1.6em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; } h4 { font-size: 1em; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
a { color: var(--link); text-decoration: underline; text-underline-offset: 2px; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 0.9em; }
code { background: var(--code-bg); padding: 0.15em 0.35em; border-radius: 4px; }
pre { background: var(--code-bg); padding: 12px 16px; border-radius: 6px; overflow-x: auto; line-height: 1.45; }
pre code { background: none; padding: 0; font-size: 0.95em; }
blockquote { margin-left: 0; padding: 0 1em; color: var(--muted); border-left: 4px solid var(--quote); }
ul, ol { padding-left: 2em; } li + li { margin-top: 0.25em; }
table { border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; }
th, td { border: 1px solid var(--rule); padding: 6px 12px; text-align: left; vertical-align: top; }
th { font-weight: 600; background: var(--code-bg); }
hr { border: 0; border-top: 1px solid var(--rule); margin: 2em 0; }
sup { line-height: 0; font-size: 0.75em; } sup a { text-decoration: none; padding: 0 1px; }
#sources { padding-left: 2em; font-size: 0.95em; } #sources li { margin-top: 0.5em; }
#sources .url { display: block; color: var(--muted); font-size: 0.85em; }
@media print { body { padding: 0; max-width: none; } a { color: inherit; } }
`.trim();

function text(value: string): Text {
  return { type: "text", value };
}

/** The handlers that differ from the defaults: citations that jump to the Sources list, images as their alt text. */
function handlers(numberOf: Map<string, number>): Partial<Handlers> {
  return {
    footnoteReference(state: State, node: FootnoteReference): ElementContent {
      const number = numberOf.get(node.identifier);
      if (number === undefined) {
        return text(`[^${node.label ?? node.identifier}]`);
      }
      const link: Element = { type: "element", tagName: "a", properties: { href: `#src-${number}` }, children: [text(String(number))] };
      const sup: Element = { type: "element", tagName: "sup", properties: { className: ["cite"] }, children: [link] };
      state.patch(node, sup);
      return sup;
    },
    image(_state: State, node: Image): ElementContent {
      return text(node.alt ?? "");
    },
    imageReference(_state: State, node: ImageReference): ElementContent {
      return text(node.alt ?? "");
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sourcesHtml(sources: ReportSource[]): string {
  if (sources.length === 0) {
    return "";
  }
  const items = sources.map((source) => {
    const title = escapeHtml(source.title);
    if (!source.url) {
      return `<li id="src-${source.number}">${title}</li>`;
    }
    const url = escapeHtml(source.url);
    return `<li id="src-${source.number}"><a href="${url}" rel="noopener">${title}</a> <span class="url">${url}</span></li>`;
  });
  return `<section class="sources">\n<h2 id="sources-heading">Sources</h2>\n<ol id="sources">\n${items.join("\n")}\n</ol>\n</section>`;
}

/** The report as a complete HTML document. */
export function renderHtml(root: Root, meta: ReportMeta): string {
  const split = splitReport(root);
  const { body, sources, numberOf } = split;
  const tree = toHast({ type: "root", children: body }, { handlers: handlers(numberOf) as Handlers });
  const article = toHtml(tree);
  const heading = headingOf(split, meta);
  const title = escapeHtml(heading.title);
  return [
    "<!doctype html>",
    `<html lang="en">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="generator" content="Ancilla">`,
    `<title>${title}</title>`,
    `<style>\n${CSS}\n</style>`,
    "</head>",
    "<body>",
    "<header>",
    `<h1>${title}</h1>`,
    ...heading.lines.map((line) => `<p class="subtitle">${escapeHtml(line)}</p>`),
    "</header>",
    "<main>",
    article,
    sourcesHtml(sources),
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
