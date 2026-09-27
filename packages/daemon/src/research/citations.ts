/**
 * Source codes and the deterministic citation pipeline.
 *
 * Port of Deep Dog 2 `deep_research/citation_utils.py` L130-343 (`extract_cited_codes`, `remap_codes`,
 * `finalize_citations`, `build_final_registry`) and the supervisor's code remap in
 * `deep_research/multi_agent_supervisor.py` L481-491 and L694-715, at commit `fc7981a`. Everything here is pure
 * string logic: the model never writes a URL, and the `## Sources` section is always built in code.
 *
 * One rule is stricter than upstream: a source a worker claims but never fetched or saw in a search result is
 * `verified: false`, and unverified sources never reach the writer's registry, so they cannot be cited.
 */

import type { CuratedSource, ObservedToolCall, SavedSource, SourceEntry } from "./types.js";

/** A registry entry as the writer sees it: the code plus whatever the worker said about the source. */
export interface FinalRegistryEntry extends SourceEntry {
  reason: string | null;
  excerpt: string | null;
}

export interface FinalizedCitations {
  report: string;
  /** The entries that were cited and present, in first-appearance order; position plus one is the footnote number. */
  cited: SourceEntry[];
  /** Codes that looked like citations but were not in the registry; they stay in the body as plain text. */
  unknownCodes: string[];
}

/**
 * The key two URLs are compared by. Fragments never change the document, hosts are case-insensitive, and a
 * trailing slash is the most common way for a worker to spell a URL differently from the search result.
 */
export function normalizeUrl(url: string): string {
  let text = url.trim();
  const hash = text.indexOf("#");
  if (hash >= 0) text = text.slice(0, hash);
  try {
    const parsed = new URL(text);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return text.replace(/\/+$/, "");
  }
}

/** Every URL a worker's observed tool calls named or returned, normalised. */
export function observedUrls(observed: ObservedToolCall[]): Set<string> {
  const seen = new Set<string>();
  for (const call of observed) {
    for (const url of call.urls ?? []) {
      if (typeof url === "string" && url.trim()) seen.add(normalizeUrl(url));
    }
    for (const result of call.results ?? []) {
      if (result && typeof result.url === "string" && result.url.trim()) seen.add(normalizeUrl(result.url));
    }
  }
  return seen;
}

/**
 * Gives one worker's saved sources their global codes `A{agentId}-S{n}`, the same shape upstream's supervisor
 * stamps on sub-agent registries. Duplicate URLs within one worker share the first entry; a source is verified
 * only when the worker's observed searches or fetches contain its URL.
 */
export function assignCodes(agentId: number, saved: SavedSource[], observed: ObservedToolCall[], round = 0): SourceEntry[] {
  const known = observedUrls(observed);
  const entries: SourceEntry[] = [];
  const seen = new Set<string>();
  for (const source of saved) {
    const url = typeof source.url === "string" ? source.url.trim() : "";
    if (!url) continue;
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      code: `A${agentId}-S${entries.length + 1}`,
      url,
      title: source.title ?? null,
      agentId,
      round,
      verified: known.has(key),
    });
  }
  return entries;
}

/**
 * The registry the final writer may cite from. Registry entries come first and keep their codes; curated
 * sources that the registry does not already hold get fresh `C{n}` codes, as upstream does. Entries are
 * deduplicated by normalised URL, and unverified ones are left out on both sides.
 */
export function buildFinalRegistry(registry: SourceEntry[], curated: CuratedSource[]): FinalRegistryEntry[] {
  const merged: FinalRegistryEntry[] = [];
  const seen = new Set<string>();
  const curatedByUrl = new Map<string, CuratedSource>();
  for (const source of curated) {
    const url = typeof source.url === "string" ? source.url.trim() : "";
    if (!url) continue;
    const key = normalizeUrl(url);
    if (!curatedByUrl.has(key)) curatedByUrl.set(key, source);
  }
  for (const entry of registry) {
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    const code = typeof entry.code === "string" ? entry.code.trim() : "";
    if (!url || !code || !entry.verified) continue;
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const detail = curatedByUrl.get(key);
    merged.push({
      ...entry,
      code,
      url,
      title: entry.title || detail?.title || null,
      reason: detail?.reason || null,
      excerpt: detail?.excerpt || null,
    });
  }
  let curatedIndex = 1;
  for (const source of curated) {
    const url = typeof source.url === "string" ? source.url.trim() : "";
    if (!url || !source.verified) continue;
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      code: `C${curatedIndex++}`,
      url,
      title: source.title ?? null,
      agentId: source.agentId,
      round: source.round,
      verified: true,
      reason: source.reason || null,
      excerpt: source.excerpt ?? null,
    });
  }
  return merged;
}

/** One code as the writer may spell it: a worker source, a curated source, or a bare worker-local code. */
const CODE_TOKEN = String.raw`(?:A\d+-S\d+|C\d+|S\d+)`;
/** A bracket group: `[A1-S2]`, `[A1-S2, A3-S1]` or `[A1-S2; C1]`. Adjacent groups `[A1-S2][A3-S1]` match twice. */
const CODE_GROUP_RE = new RegExp(String.raw`\[\s*(${CODE_TOKEN}(?:\s*[,;]\s*${CODE_TOKEN})*)\s*\]`, "g");

function splitGroup(group: string): string[] {
  return group.split(/\s*[,;]\s*/).map((code) => code.trim()).filter(Boolean);
}

/** Inline citation codes in body order, deduplicated (upstream `extract_cited_codes`). */
export function extractCitedCodes(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CODE_GROUP_RE)) {
    for (const code of splitGroup(match[1] ?? "")) {
      if (!seen.has(code)) {
        seen.add(code);
        out.push(code);
      }
    }
  }
  return out;
}

function stripCitationPlan(text: string): string {
  return text.replace(/<CitationPlanList>[\s\S]*?<\/CitationPlanList>\s*/gi, "").trim();
}

/** The report body without any Sources or References section the writer produced despite the rules. */
function bodyWithoutSources(text: string): string {
  const cleaned = stripCitationPlan(text);
  const header = /^#{1,3}\s+(?:Sources|References)\s*$/im.exec(cleaned);
  if (!header) return cleaned;
  return cleaned.slice(0, header.index).trimEnd();
}

/** Link text keeps its brackets literal; a URL with spaces or parentheses goes in angle brackets so it parses whole. */
export function markdownLink(title: string, url: string): string {
  const text = title.replace(/([\[\]\\])/g, "\\$1");
  const target = /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, (c) => encodeURIComponent(c))}>` : url;
  return `[${text}](${target})`;
}

/** One entry of the Sources section: a GFM footnote definition whose text is the title linked to the URL. */
function sourceLine(number: number, entry: SourceEntry): string {
  const title = (entry.title ?? "").trim() || "Untitled";
  return `[^${number}]: ${markdownLink(title, entry.url)}`;
}

/**
 * A body that opens a code fence and never closes it would swallow everything appended after it, Sources
 * included, into that block. Balancing the fence first keeps the sources readable whatever the writer did.
 */
function closeOpenFence(body: string): string {
  let open: string | null = null;
  for (const line of body.split("\n")) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence) continue;
    const marker = fence[1] as string;
    if (open === null) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length) open = null;
  }
  return open === null ? body : `${body}\n${open}`;
}

/** A legacy Sources line, `[3] Title (https://url)`, as written through Ancilla 0.19.1. */
const LEGACY_SOURCE_RE = /^\[(\d+)\]\s+(.*?)\s*\((\S+?)\)\s*$/;

/**
 * Reports written before footnotes cited as `[3]` and listed `[3] Title (url)` under `## Sources`. This rewrites
 * such a report into the footnote form so old runs read and export like new ones. A report already in the
 * footnote form, or without a legacy Sources section, comes back unchanged.
 */
export function modernizeCitations(report: string): string {
  const header = /^#{1,3}\s+Sources\s*$/im.exec(report);
  if (!header) return report;
  const body = report.slice(0, header.index);
  const section = report.slice(header.index + header[0].length);
  const numbers = new Set<string>();
  const lines: string[] = [];
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = LEGACY_SOURCE_RE.exec(line);
    if (!match) return report;
    numbers.add(match[1] as string);
    lines.push(`[^${match[1]}]: ${markdownLink((match[2] as string).trim() || "Untitled", match[3] as string)}`);
  }
  if (lines.length === 0) return report;
  const rewritten = body.replace(/\[(\d+)\]/g, (whole, number: string) => (numbers.has(number) ? `[^${number}]` : whole));
  return `${rewritten.trimEnd()}\n\n## Sources\n\n${lines.join("\n")}`;
}

/**
 * Keeps only the codes that are cited and present in the registry, renumbers them to footnotes `[^1..N]` in
 * first-appearance order, and appends a `## Sources` section of footnote definitions built from the registry, each
 * the title linked to the URL, so any GFM renderer makes the citations clickable. Unknown codes lose their brackets
 * and stay as plain text. When nothing valid was cited the cleaned body comes back without a Sources section, which is never
 * worse than what the writer produced (upstream `_finalize_code_citations` with `renumber=True`).
 */
export function finalizeCitations(report: string, registry: SourceEntry[]): FinalizedCitations {
  const body = bodyWithoutSources(report);
  const byCode = new Map<string, SourceEntry>();
  for (const entry of registry) {
    if (entry.code && !byCode.has(entry.code)) byCode.set(entry.code, entry);
  }
  const cited = extractCitedCodes(body);
  const valid = cited.filter((code) => byCode.has(code));
  const unknownCodes = cited.filter((code) => !byCode.has(code));
  const numberOf = new Map<string, number>();
  valid.forEach((code, index) => numberOf.set(code, index + 1));

  const rewritten = body.replace(CODE_GROUP_RE, (_whole, group: string) => {
    const known: string[] = [];
    const unknown: string[] = [];
    for (const code of splitGroup(group)) {
      const number = numberOf.get(code);
      if (number !== undefined) known.push(`[^${number}]`);
      else unknown.push(code);
    }
    if (unknown.length === 0) return known.join("");
    if (known.length === 0) return unknown.join(", ");
    return `${known.join("")} ${unknown.join(", ")}`;
  });

  const citedEntries = valid.map((code) => byCode.get(code) as SourceEntry);
  if (citedEntries.length === 0) {
    return { report: rewritten, cited: [], unknownCodes };
  }
  const lines = citedEntries.map((entry, index) => sourceLine(index + 1, entry));
  return { report: `${closeOpenFence(rewritten)}\n\n## Sources\n\n${lines.join("\n")}`, cited: citedEntries, unknownCodes };
}
