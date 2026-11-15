/**
 * Source codes and the deterministic citation pipeline.
 *
 * Port of Deep Dog 2 `deep_research/citation_utils.py` L130-343 (`extract_cited_codes`, `remap_codes`,
 * `finalize_citations`, `build_final_registry`) and the supervisor's code remap in
 * `deep_research/multi_agent_supervisor.py` L481-491 and L694-715, at commit `fc7981a`. Everything here is pure
 * string logic: the model never writes a URL, and the `## Sources` section is always built in code.
 *
 * One rule is stricter than upstream: a source a worker claims but never opened or saw in a search result is
 * `verified: false`, and unverified sources never reach the writer's registry, so they cannot be cited.
 * What the worker's calls prove is recorded as a `provenance` per URL (see `provenanceByUrl`); `verified` stays the
 * only gate on citing, and `provenance` explains it.
 */

import type { CuratedSource, ObservedToolCall, SavedSource, SourceEntry, SourceProvenance } from "./types.js";

/**
 * Decision D5: whether a URL that only appeared in a completed search result may be cited. True until real Muse
 * fixtures (a search, a fetch, a 404, a DNS failure, a redirect) say how reliable a result's URL is; flipping it
 * makes only an opened page citable, and changes nothing else in the code, but it makes the copy below false, so
 * change it with the constant: README.md ("Reports with traceable sources"), packages/ui/src/components/composer/
 * Composer.tsx (the research tooltip), packages/ui/src/components/settings/SettingsPage.tsx (the research setting's
 * description), apps/web/src/demo/client.ts (the demo report's text about where a marker points),
 * docs/deep-research-plan.md (section 12, and the lines on how the engine marks `verified` and on what a
 * citation resolves to), packages/daemon/src/research/UPSTREAM.md (the `citations.ts` row), and
 * packages/daemon/src/research/prompts/worker.ts (the save instructions, which tell a worker it may save a URL
 * it saw in its search results).
 */
export const SEARCH_ONLY_CITABLE = true;

/** What the observed calls say about one URL: how it was reached, and whether that is enough to cite it. */
export interface UrlEvidence {
  provenance: SourceProvenance;
  citable: boolean;
}

/** How much a provenance shows, strongest first: an attempt that failed outranks a search hit so the failure stays visible. */
const PROVENANCE_RANK: Record<SourceProvenance, number> = { retrieved: 3, attempted: 2, search_only: 1, unobserved: 0 };

/** The strength of a source's evidence, for choosing between two rows that name the same URL: citable first, then provenance. */
export function evidenceRank(source: { verified: boolean; provenance?: SourceProvenance | undefined }): number {
  // A provenance this build does not know (a later build wrote it, or the state is damaged) is worth nothing, so the
  // total stays a number: a NaN would go out as null, and a client cannot compare null.
  return (source.verified ? 10 : 0) + (PROVENANCE_RANK[source.provenance ?? "unobserved"] ?? 0);
}

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

/** A fetch ended ok with output, or with an output whose size the host did not report. A known empty output is no page. */
function fetchedPage(call: ObservedToolCall): boolean {
  const outcome = call.outcome ?? "ok";
  const size = call.outputSize;
  return outcome === "ok" && !(typeof size === "number" && size <= 0);
}

/** A search whose result list can be trusted: it ended ok. A search that failed or never finished lists nothing. */
function completedSearch(call: ObservedToolCall): boolean {
  return (call.outcome ?? "ok") === "ok";
}

function urlsIn(urls: unknown): string[] {
  return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string" && url.trim().length > 0) : [];
}

/**
 * What one worker's observed tool calls say about each URL they touched, keyed by the normalised URL. A fetch that
 * ended ok with output makes it `retrieved`, whatever failed before or after; a fetch that failed, was cancelled or
 * never reported makes it `attempted`, which is also what a search hit shows once a fetch of it failed; a URL only
 * in a completed search result is `search_only`. A call of the `other` kind says nothing, whatever it names, and a
 * search that did not end ok lists nothing. Citable means retrieved, or search-only while `SEARCH_ONLY_CITABLE`
 * holds, so a failed fetch of a URL no search returned is not citable, and a failed fetch of a search hit is. A URL
 * no call touched has no entry: read it as `unobserved`.
 */
export function provenanceByUrl(observed: ObservedToolCall[], searchOnlyCitable: boolean = SEARCH_ONLY_CITABLE): Map<string, UrlEvidence> {
  const retrieved = new Set<string>();
  const attempted = new Set<string>();
  const found = new Set<string>();
  for (const call of observed) {
    if (call.kind === "fetch") {
      for (const url of urlsIn(call.urls)) {
        (fetchedPage(call) ? retrieved : attempted).add(normalizeUrl(url));
      }
    } else if (call.kind === "search" && completedSearch(call)) {
      for (const url of urlsIn(call.urls)) found.add(normalizeUrl(url));
      for (const result of call.results ?? []) {
        if (result && typeof result.url === "string" && result.url.trim()) found.add(normalizeUrl(result.url));
      }
    }
  }
  const evidence = new Map<string, UrlEvidence>();
  for (const key of new Set([...retrieved, ...attempted, ...found])) {
    const provenance: SourceProvenance = retrieved.has(key) ? "retrieved" : attempted.has(key) ? "attempted" : "search_only";
    evidence.set(key, { provenance, citable: retrieved.has(key) || (searchOnlyCitable && found.has(key)) });
  }
  return evidence;
}

/**
 * Gives one worker's saved sources their global codes `A{agentId}-S{n}`, the same shape upstream's supervisor
 * stamps on sub-agent registries. Duplicate URLs within one worker share the first entry; a source is verified
 * only when the worker's own observed calls make its URL citable, and carries the provenance they gave it.
 */
export function assignCodes(agentId: number, saved: SavedSource[], observed: ObservedToolCall[], round = 0, searchOnlyCitable: boolean = SEARCH_ONLY_CITABLE): SourceEntry[] {
  const evidence = provenanceByUrl(observed, searchOnlyCitable);
  const entries: SourceEntry[] = [];
  const seen = new Set<string>();
  for (const source of saved) {
    const url = typeof source.url === "string" ? source.url.trim() : "";
    if (!url) continue;
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const found = evidence.get(key);
    entries.push({
      code: `A${agentId}-S${entries.length + 1}`,
      url,
      title: source.title ?? null,
      agentId,
      round,
      verified: found?.citable ?? false,
      provenance: found?.provenance ?? "unobserved",
    });
  }
  return entries;
}

/**
 * The registry the final writer may cite from. Registry entries come first and keep their codes; curated
 * sources that the registry does not already hold get fresh `C{n}` codes, as upstream does. Entries are
 * deduplicated by normalised URL, and unverified ones are left out on both sides. When several workers saved the
 * same URL the writer gets the row with the strongest evidence (the worker that opened the page, not one that
 * only named it); rows of equal strength keep the first.
 */
export function buildFinalRegistry(registry: SourceEntry[], curated: CuratedSource[]): FinalRegistryEntry[] {
  const merged: FinalRegistryEntry[] = [];
  const seen = new Set<string>();
  const curatedByUrl = new Map<string, CuratedSource>();
  for (const source of curated) {
    const url = typeof source.url === "string" ? source.url.trim() : "";
    if (!url) continue;
    const key = normalizeUrl(url);
    const held = curatedByUrl.get(key);
    if (!held || evidenceRank(source) > evidenceRank(held)) curatedByUrl.set(key, source);
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
      ...(source.provenance ? { provenance: source.provenance } : {}),
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

/** `[3] Title (https://url)`, `[3] https://url` or `3. Title (https://url)`: the shapes older reports listed sources in. */
const LEGACY_SOURCE_LINE = /^(?:\[(\d+)\]|(\d+)\.)\s+(.*?)\s*$/;
const TRAILING_URL = /^(.*?)\s*\(?\s*(https?:\/\/\S+?)\)?\s*$/;

/**
 * Reports written before footnotes cited as `[3]` and listed `[3] Title (url)` under `## Sources`. This rewrites
 * such a report into the footnote form so old runs read and export like new ones. A report already in the
 * footnote form, or without a legacy Sources section, comes back unchanged; a `[3]` that is a link's text or a
 * reference definition is not a citation and keeps its brackets.
 */
export function modernizeCitations(report: string): string {
  const lines = report.replace(/\r\n?/g, "\n").split("\n");
  let headingAt = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^#{1,3}\s+(?:Sources|References)\s*$/i.test(lines[i] as string)) {
      headingAt = i;
      break;
    }
  }
  if (headingAt < 0) return report;
  const numbers = new Set<string>();
  const sources = lines.slice(headingAt + 1).map((line) => {
    const match = LEGACY_SOURCE_LINE.exec(line.trim());
    if (!match) return line;
    const located = TRAILING_URL.exec((match[3] ?? "").trim());
    if (!located) return line;
    const number = (match[1] ?? match[2]) as string;
    const url = located[2] as string;
    const title = (located[1] as string).trim().replace(/[\s:–-]+$/, "") || url;
    numbers.add(number);
    return `[^${number}]: ${markdownLink(title, url)}`;
  });
  if (numbers.size === 0) return report;
  const body = lines
    .slice(0, headingAt)
    .join("\n")
    .replace(/\[(\d+)\](?![(:])/g, (whole, number: string) => (numbers.has(number) ? `[^${number}]` : whole));
  return [body, lines[headingAt], ...sources].join("\n");
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
