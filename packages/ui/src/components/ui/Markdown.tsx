import { CheckIcon, CopyIcon } from "./icons.js";
import {
  Children,
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { looksLikeFilePath, type FileTarget } from "../../model/files.js";
import { STREAM_SAMPLE_MS, streamRenderMode } from "../../model/streaming.js";
import { useSampledText } from "../../app/sampled.js";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlight } from "sugar-high";
import { cn } from "./primitives.js";
import { SwapIcon } from "./sourced.js";

export function useCopy(timeout = 1400): [boolean, (text: string) => void] {
  const [copiedState, setCopiedState] = useState<boolean>(false);
  const activeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPending = useCallback(() => {
    if (activeTimer.current !== null) {
      clearTimeout(activeTimer.current);
      activeTimer.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearPending();
  }, [clearPending]);

  const triggerCopy = useCallback((textPayload: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(textPayload).then(() => {
      setCopiedState(true);
      clearPending();
      activeTimer.current = setTimeout(() => {
        setCopiedState(false);
      }, timeout);
    });
  }, [clearPending, timeout]);

  return [copiedState, triggerCopy];
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [isCopied, performCopy] = useCopy();
  const accessibilityTitle = isCopied ? "Copied" : label;
  const buttonGlyph = isCopied ? <CheckIcon size={13} className="text-ok" /> : <CopyIcon size={13} />;

  return (
    <button type="button"
      aria-label={accessibilityTitle}
      onClick={() => performCopy(text)}
      className={cn("inline-flex size-6 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg", className)}
    >
      <SwapIcon value={isCopied ? "copied" : "copy"}>
        {buttonGlyph}
      </SwapIcon>
    </button>
  );
}

const SUPPORTED_CODE_LANGUAGES = new Set([
  "js", "jsx", "ts", "tsx", "javascript", "typescript",
  "json", "jsonc", "css", "scss", "html", "xml",
  "java", "c", "cpp", "cs", "go", "rust", "rs",
  "swift", "kotlin", "php", "py", "python", "rb", "ruby",
  "sh", "bash", "zsh", "shell", "ps1", "powershell",
  "sql", "yaml", "yml", "toml", "lua", "dart"
]);

const FILE_EXT_LANGUAGE_TABLE: Record<string, string> = {
  ts: "ts", tsx: "tsx", mts: "ts", cts: "ts",
  js: "js", jsx: "jsx", mjs: "js", cjs: "js",
  json: "json", jsonc: "jsonc",
  css: "css", scss: "scss", html: "html", xml: "xml",
  java: "java", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
  cs: "cs", go: "go", rs: "rs", swift: "swift", kt: "kotlin",
  php: "php", py: "py", rb: "rb",
  sh: "sh", bash: "bash", zsh: "zsh", ps1: "ps1",
  sql: "sql", yaml: "yaml", yml: "yml", toml: "toml",
  lua: "lua", dart: "dart",
};

export function languageFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const extensionMatch = /\.([A-Za-z0-9]+)$/.exec(path);
  const normalizedExt = extensionMatch?.[1]?.toLowerCase();
  if (!normalizedExt) return null;
  const matchedLang = FILE_EXT_LANGUAGE_TABLE[normalizedExt];
  return matchedLang && SUPPORTED_CODE_LANGUAGES.has(matchedLang) ? matchedLang : null;
}

function safeHighlightSnippet(rawSnippet: string): string | null {
  try {
    const outputHtml = highlight(rawSnippet);
    return outputHtml;
  } catch {
    return null;
  }
}

export function highlightCode(code: string, language: string | null): string | null {
  if (!language || code.length === 0 || code.length > 2000) return null;
  if (!SUPPORTED_CODE_LANGUAGES.has(language.toLowerCase())) return null;
  return safeHighlightSnippet(code);
}

export const CodeBlock = memo(function CodeBlock({ code, language, className }: { code: string; language: string | null; className?: string }) {
  const formattedHtml = useMemo(() => {
    if (code.length > 60_000 || (language && !SUPPORTED_CODE_LANGUAGES.has(language.toLowerCase()))) return null;
    return safeHighlightSnippet(code);
  }, [code, language]);

  return (
    <div className={cn("code-surface group/code my-3 overflow-hidden rounded-xl bg-sunken shadow-[0_0_0_1px_var(--border)]", className)}>
      <header className="flex h-8 items-center justify-between pl-3.5 pr-1">
        <span className="font-mono text-2xs text-subtle">{language ?? "text"}</span>
        <CopyButton text={code} label="Copy code" className="opacity-60 group-hover/code:opacity-100 focus-visible:opacity-100" />
      </header>
      <pre className="max-h-[480px] overflow-auto pb-3 px-3.5">
        {formattedHtml !== null ? <code dangerouslySetInnerHTML={{ __html: formattedHtml }} /> : <code>{code}</code>}
      </pre>
    </div>
  );
});

function extractTextContent(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return `${node}`;
  if (Array.isArray(node)) return node.map(extractTextContent).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return extractTextContent(node.props.children);
  return "";
}

export interface FileLinks {
  readonly resolve: (href: string) => FileTarget | null;
  readonly open: (target: FileTarget) => void;
  readonly imageUrl?: (src: string) => string | null;
}

export const FileLinksContext = createContext<FileLinks | null>(null);

function navigateToAnchor(targetAnchor: string): void {
  const rawId = targetAnchor.startsWith("#") ? targetAnchor.slice(1) : targetAnchor;
  let decodedId = rawId;
  try {
    decodedId = decodeURIComponent(rawId);
  } catch {
    // Retain fallback raw identifier
  }
  requestAnimationFrame(() => {
    const targetElement = document.getElementById(decodedId);
    if (!targetElement) return;
    targetElement.scrollIntoView({ block: "center", behavior: "smooth" });
    targetElement.classList.add("jumped");
    setTimeout(() => targetElement.classList.remove("jumped"), 1600);
  });
}

type AnchorProps = Omit<ComponentPropsWithoutRef<"a">, "ref">;

function MarkdownAnchor({ href, children, node: _unusedAstNode, ...extraAttrs }: AnchorProps & { node?: unknown }) {
  const fileLinkResolver = useContext(FileLinksContext);
  const resolvedTarget = fileLinkResolver && href ? fileLinkResolver.resolve(href) : null;

  if (href?.startsWith("#")) {
    return (
      <a
        {...extraAttrs}
        href={href}
        onClick={(clickEvt) => {
          clickEvt.preventDefault();
          navigateToAnchor(href);
        }}
      >
        {children}
      </a>
    );
  }

  if (fileLinkResolver && resolvedTarget) {
    return (
      <a
        {...extraAttrs}
        href={href}
        title={`Open ${resolvedTarget.path}`}
        onClick={(clickEvt) => {
          clickEvt.preventDefault();
          fileLinkResolver.open(resolvedTarget);
        }}
      >
        {children}
      </a>
    );
  }

  return (
    <a href={href} target="_blank" rel="noreferrer noopener" {...extraAttrs}>
      {children}
    </a>
  );
}

function InlineCodeSnippet({ className, children }: { className?: string; children?: ReactNode }) {
  const navigationLinks = useContext(FileLinksContext);
  const codeContent = typeof children === "string" ? children : null;
  const targetDescriptor = navigationLinks && codeContent && !className && looksLikeFilePath(codeContent)
    ? navigationLinks.resolve(codeContent)
    : null;

  if (navigationLinks && targetDescriptor) {
    return (
      <code
        tabIndex={0}
        role="link"
        title={`Open ${targetDescriptor.path}`}
        className="cursor-pointer underline-offset-2 decoration-[color-mix(in_oklch,var(--accent-text)_45%,transparent)] hover:text-accent-text hover:underline"
        onClick={() => navigationLinks.open(targetDescriptor)}
        onKeyDown={(keyEvt) => {
          if (keyEvt.key === "Enter") {
            keyEvt.preventDefault();
            navigationLinks.open(targetDescriptor);
          }
        }}
      >
        {codeContent}
      </code>
    );
  }

  return <code className={className}>{children}</code>;
}

function EmbeddedMarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const fileContext = useContext(FileLinksContext);
  const sourceString = typeof src === "string" ? src : undefined;
  const finalImageUri = sourceString && fileContext?.imageUrl
    ? (fileContext.imageUrl(sourceString) ?? sourceString)
    : sourceString;
  return <img src={finalImageUri} alt={alt ?? ""} loading="lazy" className="max-w-full rounded-lg" />;
}

function RenderedPreformatted({ children }: { children?: ReactNode }) {
  const primaryChild = Children.toArray(children)[0];
  if (isValidElement<{ className?: string; children?: ReactNode }>(primaryChild)) {
    const langExtractor = /language-([\w+#-]+)/.exec(primaryChild.props.className ?? "");
    const recognizedLang = langExtractor?.[1] ?? null;
    const cleanSource = extractTextContent(primaryChild.props.children).replace(/\n$/, "");
    return <CodeBlock code={cleanSource} language={recognizedLang} />;
  }
  return <pre className="overflow-x-auto">{children}</pre>;
}

function RenderedTable({ children }: { children?: ReactNode }) {
  return (
    <div className="overflow-x-auto my-3">
      <table className="min-w-full">{children}</table>
    </div>
  );
}

const MARKDOWN_RENDERERS: Components = {
  a: (anchorProps) => <MarkdownAnchor {...anchorProps} />,
  code: ({ className, children }) => <InlineCodeSnippet className={className}>{children}</InlineCodeSnippet>,
  img: ({ src, alt }) => <EmbeddedMarkdownImage src={src} alt={alt} />,
  pre: ({ children }) => <RenderedPreformatted>{children}</RenderedPreformatted>,
  table: ({ children }) => <RenderedTable>{children}</RenderedTable>,
};

type HastNode = Record<string, any>;

function rehypeWordsTransformer() {
  const walkNodes = (currentNode: HastNode): void => {
    if (!currentNode.children || currentNode.tagName === "pre" || currentNode.tagName === "code") return;
    const updatedChildrenList: HastNode[] = [];
    for (const subItem of currentNode.children) {
      if (subItem.type === "text" && subItem.value) {
        for (const tokenSlice of subItem.value.split(/(\s+)/)) {
          if (!tokenSlice) continue;
          updatedChildrenList.push(
            /^\s+$/.test(tokenSlice)
              ? { type: "text", value: tokenSlice }
              : { type: "element", tagName: "span", properties: { className: ["tok"] }, children: [{ type: "text", value: tokenSlice }] },
          );
        }
        continue;
      }
      walkNodes(subItem);
      updatedChildrenList.push(subItem);
    }
    currentNode.children = updatedChildrenList;
  };

  return (rootTree: HastNode) => walkNodes(rootTree);
}

const WORDS_STREAM_PLUGINS = [rehypeWordsTransformer];

function rehypeFootnoteHostnames() {
  const resolveDomainHost = (urlTarget: unknown): string | null => {
    if (typeof urlTarget !== "string" || !/^https?:\/\//i.test(urlTarget)) return null;
    try {
      return new URL(urlTarget).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  };

  const augmentFootnoteListing = (listItemNode: HastNode): void => {
    for (const paragraphNode of listItemNode.children ?? []) {
      const childElements = paragraphNode.children ?? [];
      const anchorIndex = childElements.findIndex((child: any) => child.tagName === "a" && resolveDomainHost(child.properties?.["href"]) !== null);
      if (anchorIndex < 0) continue;
      const hostLabel = resolveDomainHost(childElements[anchorIndex]?.properties?.["href"]) as string;
      childElements.splice(anchorIndex + 1, 0, {
        type: "element",
        tagName: "span",
        properties: { className: ["src-host"] },
        children: [{ type: "text", value: hostLabel }],
      });
      paragraphNode.children = childElements;
      return;
    }
  };

  const inspectAstBranch = (inspectedNode: HastNode): void => {
    if (inspectedNode.tagName === "section" && inspectedNode.properties?.["dataFootnotes"] !== undefined) {
      for (const listContainer of inspectedNode.children ?? []) {
        if (listContainer.tagName !== "ol") continue;
        for (const footnoteEntry of listContainer.children ?? []) {
          if (footnoteEntry.tagName === "li") augmentFootnoteListing(footnoteEntry);
        }
      }
      return;
    }
    for (const nestedBranch of inspectedNode.children ?? []) inspectAstBranch(nestedBranch);
  };

  return (astDocument: HastNode) => inspectAstBranch(astDocument);
}

const FOOTNOTE_SOURCE_PLUGINS = [rehypeFootnoteHostnames];
const COMBINED_STREAM_FOOTNOTE_PLUGINS = [rehypeWordsTransformer, rehypeFootnoteHostnames];
const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

function configureFootnoteOptions(idPrefix: string): Options["remarkRehypeOptions"] {
  return {
    clobberPrefix: idPrefix,
    footnoteLabel: "Sources",
    footnoteLabelProperties: { className: ["sr-only"] },
    footnoteBackLabel: (indexNumber: number) => `Back to citation ${indexNumber + 1}`,
  };
}

export const Markdown = memo(function Markdown({
  text,
  className,
  stream = false,
  footnotePrefix,
}: {
  text: string;
  className?: string;
  stream?: boolean;
  footnotePrefix?: string;
}) {
  const presentationMode = streamRenderMode(text.length, stream);
  const streamBodyText = useSampledText(text, presentationMode === "sampled", STREAM_SAMPLE_MS);
  const rehypeOptionsConfig = useMemo(() => (footnotePrefix ? configureFootnoteOptions(footnotePrefix) : undefined), [footnotePrefix]);

  const activeRehypePipeline = footnotePrefix
    ? presentationMode === "words"
      ? COMBINED_STREAM_FOOTNOTE_PLUGINS
      : FOOTNOTE_SOURCE_PLUGINS
    : presentationMode === "words"
      ? WORDS_STREAM_PLUGINS
      : undefined;

  return (
    <div className={cn("prose-ancilla", className)}>
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={activeRehypePipeline}
        remarkRehypeOptions={rehypeOptionsConfig}
        components={MARKDOWN_RENDERERS}
      >
        {streamBodyText}
      </ReactMarkdown>
    </div>
  );
});
