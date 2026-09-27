import { CheckIcon, CopyIcon } from "./icons.js";
import { Children, createContext, isValidElement, memo, useContext, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { looksLikeFilePath, type FileTarget } from "../../model/files.js";
import { STREAM_SAMPLE_MS, streamRenderMode } from "../../model/streaming.js";
import { useSampledText } from "../../app/sampled.js";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlight } from "sugar-high";
import { cn } from "./primitives.js";
import { SwapIcon } from "./sourced.js";

export function useCopy(timeout = 1400): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
  }, []);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
      timer.current = window.setTimeout(() => setCopied(false), timeout);
    });
  };
  return [copied, copy];
}

export function CopyButton(props: { text: string; label?: string; className?: string }) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : (props.label ?? "Copy")}
      onClick={() => copy(props.text)}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg",
        props.className,
      )}
    >
      <SwapIcon value={copied ? "copied" : "copy"}>
        {copied ? <CheckIcon size={13} className="text-ok" /> : <CopyIcon size={13} />}
      </SwapIcon>
    </button>
  );
}

const HIGHLIGHTABLE = /^(js|jsx|ts|tsx|javascript|typescript|json|jsonc|css|scss|html|xml|java|c|cpp|cs|go|rust|rs|swift|kotlin|php|py|python|rb|ruby|sh|bash|zsh|shell|ps1|powershell|sql|yaml|yml|toml|lua|dart)$/i;

/** What a file extension implies about its language, for colouring a diff the same way a code block is coloured. */
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "cs",
  go: "go",
  rs: "rs",
  swift: "swift",
  kt: "kotlin",
  php: "php",
  py: "py",
  rb: "rb",
  sh: "sh",
  bash: "bash",
  zsh: "zsh",
  ps1: "ps1",
  sql: "sql",
  yaml: "yaml",
  yml: "yml",
  toml: "toml",
  lua: "lua",
  dart: "dart",
};

/** The language a path implies, or null when nothing here can colour it. */
export function languageFromPath(path: string | null | undefined): string | null {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path ?? "")?.[1]?.toLowerCase();
  const language = extension ? EXTENSION_LANGUAGE[extension] : undefined;
  return language && HIGHLIGHTABLE.test(language) ? language : null;
}

/** Highlighted HTML for a line or a block, or null when it is not worth colouring. */
export function highlightCode(code: string, language: string | null): string | null {
  if (!language || code.length === 0 || code.length > 2000) {
    return null;
  }
  try {
    return highlight(code);
  } catch {
    return null;
  }
}

export const CodeBlock = memo(function CodeBlock(props: { code: string; language: string | null; className?: string }) {
  const html = useMemo(() => {
    if (props.code.length > 60_000 || (props.language && !HIGHLIGHTABLE.test(props.language))) {
      return null;
    }
    try {
      return highlight(props.code);
    } catch {
      return null;
    }
  }, [props.code, props.language]);
  return (
    <div className={cn("code-surface group/code my-3 overflow-hidden rounded-xl bg-sunken shadow-[0_0_0_1px_var(--border)]", props.className)}>
      <div className="flex h-8 items-center justify-between pr-1 pl-3.5">
        <span className="font-mono text-2xs text-subtle">{props.language ?? "text"}</span>
        <CopyButton text={props.code} label="Copy code" className="opacity-60 group-hover/code:opacity-100 focus-visible:opacity-100" />
      </div>
      <pre className="max-h-[480px] overflow-auto px-3.5 pb-3">
        {html !== null ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{props.code}</code>}
      </pre>
    </div>
  );
});

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textOf(node.props.children);
  }
  return "";
}

/**
 * Where paths in rendered markdown lead. Inside a thread they open in the file viewer; inside a previewed file they
 * resolve from that file's folder, and relative images load from the project. Without it, markdown renders as before.
 */
export interface FileLinks {
  resolve(href: string): FileTarget | null;
  open(target: FileTarget): void;
  /** A URL for a project image a preview embeds; null leaves the source as written. */
  imageUrl?(src: string): string | null;
}

export const FileLinksContext = createContext<FileLinks | null>(null);

/**
 * A link into the same document, such as a footnote reference or its way back: scrolled to rather than navigated
 * to, since the app's route lives in the hash. The scroll waits a frame so a container that opens on the click
 * (a folded report, say) has laid out first.
 */
function jumpTo(href: string): void {
  let id = href.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    /* an odd id is looked up as written */
  }
  requestAnimationFrame(() => {
    const element = document.getElementById(id);
    if (!element) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    element.classList.add("jumped");
    setTimeout(() => element.classList.remove("jumped"), 1600);
  });
}

type LinkProps = Omit<ComponentPropsWithoutRef<"a">, "ref">;

/** Rendered links keep the attributes markdown gave them (a footnote's id and back-reference marks among them). */
function MarkdownLink({ href, children, node: _node, ...rest }: LinkProps & { node?: unknown }) {
  const links = useContext(FileLinksContext);
  const target = links && href ? links.resolve(href) : null;
  if (href?.startsWith("#")) {
    return (
      <a
        {...rest}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          jumpTo(href);
        }}
      >
        {children}
      </a>
    );
  }
  if (links && target) {
    return (
      <a
        {...rest}
        href={href}
        title={`Open ${target.path}`}
        onClick={(event) => {
          event.preventDefault();
          links.open(target);
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/** Inline code naming a file, like `src/app.ts:12`, opens it; any other inline code is left alone. */
function InlineCode(props: { className?: string; children?: ReactNode }) {
  const links = useContext(FileLinksContext);
  const text = typeof props.children === "string" ? props.children : null;
  const target = links && text && !props.className && looksLikeFilePath(text) ? links.resolve(text) : null;
  if (links && target) {
    return (
      <code
        role="link"
        tabIndex={0}
        title={`Open ${target.path}`}
        className="cursor-pointer decoration-[color-mix(in_oklch,var(--accent-text)_45%,transparent)] underline-offset-2 hover:text-accent-text hover:underline"
        onClick={() => links.open(target)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            links.open(target);
          }
        }}
      >
        {text}
      </code>
    );
  }
  return <code className={props.className}>{props.children}</code>;
}

function MarkdownImage(props: { src?: string | Blob; alt?: string }) {
  const links = useContext(FileLinksContext);
  const raw = typeof props.src === "string" ? props.src : undefined;
  const src = raw && links?.imageUrl ? (links.imageUrl(raw) ?? raw) : raw;
  return <img src={src} alt={props.alt ?? ""} loading="lazy" className="max-w-full rounded-lg" />;
}

const COMPONENTS: Components = {
  a: (props) => <MarkdownLink {...props} />,
  code: ({ className, children }) => <InlineCode className={className}>{children}</InlineCode>,
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
  pre: ({ children }) => {
    const child = Children.toArray(children)[0];
    if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
      const language = /language-([\w+#-]+)/.exec(child.props.className ?? "")?.[1] ?? null;
      return <CodeBlock code={textOf(child.props.children).replace(/\n$/, "")} language={language} />;
    }
    return <pre>{children}</pre>;
  },
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

const PLUGINS = [remarkGfm];

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Wraps each word of prose in a span while text is still streaming, so a word that just arrived can fade in
 * on its own. Word positions never shift as text is appended, so React keeps the old spans and only the new
 * ones mount and animate. Code keeps its own markup.
 */
function rehypeWords() {
  const walk = (node: HastNode): void => {
    if (!node.children || node.tagName === "pre" || node.tagName === "code") {
      return;
    }
    const next: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && child.value) {
        for (const part of child.value.split(/(\s+)/)) {
          if (!part) {
            continue;
          }
          next.push(
            /^\s+$/.test(part)
              ? { type: "text", value: part }
              : { type: "element", tagName: "span", properties: { className: ["tok"] }, children: [{ type: "text", value: part }] },
          );
        }
        continue;
      }
      walk(child);
      next.push(child);
    }
    node.children = next;
  };
  return (tree: HastNode) => walk(tree);
}

const STREAM_PLUGINS = [rehypeWords];

/**
 * Each Sources entry gets the page's host after its title, so the reader can weigh a source without following
 * it: `Understanding Success Criterion 1.4.3 · w3.org`. The link is the first outside link in the entry.
 */
function rehypeSourceHosts() {
  const hostOf = (href: unknown): string | null => {
    if (typeof href !== "string" || !/^https?:\/\//i.test(href)) return null;
    try {
      return new URL(href).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  };
  const decorate = (item: HastNode): void => {
    for (const block of item.children ?? []) {
      const children = block.children ?? [];
      const index = children.findIndex((child) => child.tagName === "a" && hostOf(child.properties?.["href"]) !== null);
      if (index < 0) continue;
      const host = hostOf(children[index]?.properties?.["href"]) as string;
      children.splice(index + 1, 0, { type: "element", tagName: "span", properties: { className: ["src-host"] }, children: [{ type: "text", value: host }] });
      block.children = children;
      return;
    }
  };
  const walk = (node: HastNode): void => {
    if (node.tagName === "section" && node.properties?.["dataFootnotes"] !== undefined) {
      for (const list of node.children ?? []) {
        if (list.tagName !== "ol") continue;
        for (const item of list.children ?? []) if (item.tagName === "li") decorate(item);
      }
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  return (tree: HastNode) => walk(tree);
}

const FOOTNOTE_PLUGINS = [rehypeSourceHosts];
const STREAM_FOOTNOTE_PLUGINS = [rehypeWords, rehypeSourceHosts];

/**
 * Agent prose: GitHub-flavored markdown with highlighted code blocks. `stream` fades in each new
 * word while the text is short; a huge stream renders plain, then from a throttled snapshot, so
 * it cannot cost a full re-parse on every flush.
 */
/**
 * Footnotes render as superscript links to a list at the end. Their element ids are prefixed per document, so two
 * documents on one page (two reports in a thread) never share an id. The list's own heading stays out of sight:
 * a document that wants one writes it, as research reports do with `## Sources`.
 */
function footnoteOptions(prefix: string): Options["remarkRehypeOptions"] {
  return {
    clobberPrefix: prefix,
    footnoteLabel: "Sources",
    footnoteLabelProperties: { className: ["sr-only"] },
    footnoteBackLabel: (referenceIndex: number) => `Back to citation ${referenceIndex + 1}`,
  };
}

export const Markdown = memo(function Markdown(props: { text: string; className?: string; stream?: boolean; footnotePrefix?: string }) {
  const mode = streamRenderMode(props.text.length, props.stream ?? false);
  const shown = useSampledText(props.text, mode === "sampled", STREAM_SAMPLE_MS);
  const remarkRehypeOptions = useMemo(() => (props.footnotePrefix ? footnoteOptions(props.footnotePrefix) : undefined), [props.footnotePrefix]);
  const rehypePlugins = props.footnotePrefix ? (mode === "words" ? STREAM_FOOTNOTE_PLUGINS : FOOTNOTE_PLUGINS) : mode === "words" ? STREAM_PLUGINS : undefined;
  return (
    <div className={cn("prose-ancilla", props.className)}>
      <ReactMarkdown
        remarkPlugins={PLUGINS}
        rehypePlugins={rehypePlugins}
        remarkRehypeOptions={remarkRehypeOptions}
        components={COMPONENTS}
      >
        {shown}
      </ReactMarkdown>
    </div>
  );
});
