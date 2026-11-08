import { execFileSync } from "node:child_process";
import { DEFAULT_EMBEDDING_SETTINGS } from "../embed.js";
import { meaningScore, selectByMeaning, type Selection } from "../meaning.js";
import type { Hit } from "../rank.js";
import type { MemoryStore, RetrieveInput } from "../store.js";
import { identifiersOf, tokens } from "../text.js";
import type { AssembledContext, MemoryItem, RetrievalQuery } from "../types.js";

/**
 * The techniques the evaluation decides about adopting, each as a change to the candidates that retrieval scores and
 * nothing else: the filtering, the ranking and the budget are the shipped ones. A technique earns its place only if it
 * helps on the held-out set, not just on the set it was tuned on.
 */

export type Variant = (store: MemoryStore, input: RetrieveInput) => AssembledContext;

// ---------------------------------------------------------------------------------------------- lexical expansion

/**
 * Groups of words that stand for each other in the kind of talk these notes hold. Written by hand from the
 * development material's vocabulary and general usage; the held-out set uses its own wording, some of it in these
 * groups and some not, which is what shows whether a lexicon like this generalises.
 */
const CLUSTERS: string[][] = [
  ["deploy", "ship", "release", "publish", "rollout"],
  ["database", "db", "datastore", "storage"],
  ["server", "host", "machine", "node"],
  ["folder", "directory", "dir", "path"],
  ["branch", "ref", "stream"],
  ["prefer", "like", "favour", "favor"],
  ["address", "url", "hostname", "location"],
  ["notes", "changelog", "summary", "summaries"],
  ["meeting", "call", "sync", "standup", "retro", "retrospective"],
  ["engineer", "developer", "owner", "contact"],
  ["freeze", "cutoff"],
  ["license", "licence", "terms"],
  ["limit", "cap", "quota", "maximum", "throughput"],
  ["expire", "expires", "timeout", "ttl"],
  ["language", "interpreter", "runtime"],
  ["design", "mockup", "mockups", "figma"],
  ["backup", "backups", "snapshot"],
  ["check", "validate", "verify", "lint"],
  ["commit", "push"],
  ["tracker", "board"],
  ["registry", "artifact", "artifacts", "package", "packages"],
  ["security", "vulnerability", "breach"],
  ["production", "prod"],
  ["region", "datacentre", "datacenter", "facility"],
];

const BY_WORD = new Map<string, string[]>();
for (const cluster of CLUSTERS) for (const w of cluster) BY_WORD.set(w, [...(BY_WORD.get(w) ?? []), ...cluster.filter((x) => x !== w)]);

/** The words of a question and, for each, the words that stand for it. */
export function expansionWords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (const w of words) for (const alt of BY_WORD.get(w) ?? []) out.add(alt);
  return [...out];
}

function hitFor(item: MemoryItem, lexical: number): Hit {
  return { item, lexical };
}

function known(hits: Hit[]): Set<string> {
  return new Set(hits.map((h) => h.item.id));
}

/** Notes that share a word with the question once its words are widened to the ones that stand for them. */
export function withExpansion(store: MemoryStore, question: string) {
  return (hits: Hit[], query: RetrievalQuery): Hit[] => {
    const alts = expansionWords(question);
    if (alts.length === 0) return hits;
    const have = known(hits);
    const out = [...hits];
    const original = new Set(tokens(question));
    const found = store.list({ status: "active", q: alts.join(" "), limit: 60 }).items;
    for (const item of found) {
      if (have.has(item.id) || !query.scopes.some((s) => s.kind === item.scope.kind && s.key === item.scope.key)) continue;
      const t = new Set(tokens(item.text));
      const viaAlt = alts.filter((a) => t.has(a) || [...t].some((x) => x.startsWith(a))).length;
      // It must share something with the question itself as well as a stand-in word, or one stand-in match is just noise.
      const direct = [...original].filter((w) => t.has(w)).length;
      if (viaAlt >= 1 && direct + viaAlt >= 2) out.push(hitFor(item, Math.min(0.6, 0.25 + 0.1 * (direct + viaAlt))));
    }
    return out;
  };
}

// ---------------------------------------------------------------------------------------------- hashed vectors

const DIM = 1024;

function fnv(text: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Words and their character trigrams, hashed to a fixed width with a sign, counted, and scaled to length one. */
export function embed(text: string): Float32Array {
  const v = new Float32Array(DIM);
  const add = (feature: string, weight: number): void => {
    const h = fnv(feature, 1);
    v[h % DIM] = (v[h % DIM] as number) + (fnv(feature, 2) & 1 ? weight : -weight);
  };
  for (const w of tokens(text)) {
    add(`w:${w}`, 1);
    const padded = `^${w}$`;
    for (let i = 0; i + 3 <= padded.length; i += 1) add(`t:${padded.slice(i, i + 3)}`, 0.5);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i += 1) v[i] = (v[i] as number) / norm;
  return v;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < DIM; i += 1) s += (a[i] as number) * (b[i] as number);
  return s;
}

const VECTORS = new WeakMap<MemoryStore, Map<string, Float32Array>>();

function vectorOf(store: MemoryStore, item: MemoryItem): Float32Array {
  let cache = VECTORS.get(store);
  if (!cache) {
    cache = new Map();
    VECTORS.set(store, cache);
  }
  const key = `${item.id}:${item.rev}`;
  let v = cache.get(key);
  if (!v) {
    v = embed(item.text);
    cache.set(key, v);
  }
  return v;
}

function everything(store: MemoryStore): MemoryItem[] {
  const out: MemoryItem[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = store.list({ status: "active", limit: 200, offset }).items;
    out.push(...page);
    if (page.length < 200) return out;
  }
}

/** Notes whose words and word pieces are close to the question's, however few whole words they share. */
export function withVectors(store: MemoryStore, threshold = 0.4) {
  return (hits: Hit[], query: RetrievalQuery): Hit[] => {
    const q = embed(query.text);
    const have = known(hits);
    const out = [...hits];
    for (const item of everything(store)) {
      if (have.has(item.id) || !query.scopes.some((s) => s.kind === item.scope.kind && s.key === item.scope.key)) continue;
      const c = cosine(q, vectorOf(store, item));
      if (c >= threshold) out.push(hitFor(item, Math.min(0.7, c)));
    }
    return out;
  };
}

// ---------------------------------------------------------------------------------------------- meaning vectors

/**
 * Notes whose meaning is close to the question's, from a real embedding model behind the common `/embeddings`
 * endpoint (a local llama.cpp, Ollama or LM Studio server). Only registered when
 * `ANCILLA_EVAL_EMBED_URL` is set, because the evaluation otherwise calls no model; the evaluation is synchronous, so the
 * request is made with curl. Texts are embedded once and kept.
 */
const MEANING_CACHE = new Map<string, Float32Array>();

function normalised(v: number[]): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Float32Array.from(v, (x) => x / norm);
}

function embedSync(url: string, model: string, texts: readonly string[]): Float32Array[] {
  const out: Float32Array[] = [];
  for (let from = 0; from < texts.length; from += 64) {
    const body = JSON.stringify({ model, input: texts.slice(from, from + 64) });
    const raw = execFileSync("curl", ["-s", "-X", "POST", `${url.replace(/\/+$/, "")}/embeddings`, "-H", "content-type: application/json", "--data-binary", "@-"], { input: body, maxBuffer: 512 * 1024 * 1024, encoding: "utf8" });
    const parsed = JSON.parse(raw) as { data?: { embedding: number[]; index: number }[] };
    if (!parsed.data) throw new Error(`the embedding server answered without data: ${raw.slice(0, 200)}`);
    for (const d of [...parsed.data].sort((a, b) => a.index - b.index)) out.push(normalised(d.embedding));
  }
  return out;
}

/** Every note in the question's scopes with its cosine to the question, nearest first. */
function nearestByMeaning(store: MemoryStore, url: string, model: string, queryPrefix: string, query: RetrievalQuery): { id: string; item: MemoryItem; cosine: number }[] {
  const items = everything(store).filter((item) => query.scopes.some((s) => s.kind === item.scope.kind && s.key === item.scope.key));
  const missing = [...new Set(items.map((i) => i.text).filter((t) => !MEANING_CACHE.has(t)))];
  if (missing.length > 0) embedSync(url, model, missing).forEach((v, i) => MEANING_CACHE.set(missing[i] as string, v));
  const queryText = `${queryPrefix}${query.text}`;
  if (!MEANING_CACHE.has(queryText)) MEANING_CACHE.set(queryText, embedSync(url, model, [queryText])[0] as Float32Array);
  const q = MEANING_CACHE.get(queryText) as Float32Array;
  return items
    .map((item) => {
      const v = MEANING_CACHE.get(item.text) as Float32Array;
      let cosine = 0;
      for (let i = 0; i < q.length; i += 1) cosine += (q[i] as number) * (v[i] as number);
      return { id: item.id, item, cosine };
    })
    .sort((a, b) => b.cosine - a.cosine);
}

/** The shipped selection (`selectByMeaning`) run on a real model's cosines: what the assistant would add, and nothing else changed. */
export function withMeaningSelection(store: MemoryStore, url: string, model: string, queryPrefix: string, selection: Selection) {
  return (hits: Hit[], query: RetrievalQuery): Hit[] => {
    const base = Math.min(selection.bar, selection.floor);
    const chosen = selectByMeaning(nearestByMeaning(store, url, model, queryPrefix, query), known(hits), selection);
    return [...hits, ...chosen.map((n) => hitFor(n.item, meaningScore(n.cosine, base)))];
  };
}

/** Notes at least `threshold` close in meaning, at most the closest `most`: a question has an answer or two, not a dozen near neighbours. */
export function withMeaning(store: MemoryStore, url: string, model: string, queryPrefix: string, threshold: number, most = Infinity) {
  return withMeaningSelection(store, url, model, queryPrefix, { bar: threshold, floor: Infinity, gap: 0, most });
}

// ---------------------------------------------------------------------------------------------- identifier graph

/** From the best matches, the notes that share an identifier or two rare words with them: a one-step walk. */
export function withGraph(store: MemoryStore) {
  return (hits: Hit[], query: RetrievalQuery): Hit[] => {
    const seeds = [...hits].filter((h) => h.lexical > 0).sort((a, b) => b.lexical - a.lexical).slice(0, 3);
    if (seeds.length === 0) return hits;
    const have = known(hits);
    const out = [...hits];
    for (const seed of seeds) {
      const ids = identifiersOf(seed.item.text);
      if (ids.length === 0) continue;
      for (const item of store.list({ status: "active", q: ids.join(" "), limit: 20 }).items) {
        if (have.has(item.id) || !query.scopes.some((s) => s.kind === item.scope.kind && s.key === item.scope.key)) continue;
        if (item.identifiers.some((id) => ids.includes(id))) {
          out.push(hitFor(item, 0.3));
          have.add(item.id);
        }
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------------------------------------- one rare word

/**
 * A note that shares a single word with the question, when that word is rare among the notes: "license" in a store with
 * one note about licenses is evidence, "server" in a store with ten is not. The shipped retrieval wants a third of the
 * question's words, which a three-word question cannot give on one word.
 */
export function withRareWords(store: MemoryStore, maxFrequency = 2) {
  return (hits: Hit[], query: RetrievalQuery): Hit[] => {
    const words = new Set(tokens(query.text));
    if (words.size === 0) return hits;
    const all = everything(store);
    const df = new Map<string, number>();
    for (const item of all) for (const w of new Set(tokens(item.text))) df.set(w, (df.get(w) ?? 0) + 1);
    const have = known(hits);
    const out = [...hits];
    for (const item of all) {
      if (have.has(item.id) || !query.scopes.some((s) => s.kind === item.scope.kind && s.key === item.scope.key)) continue;
      const shared = [...new Set(tokens(item.text))].filter((w) => words.has(w) && w.length >= 4);
      if (shared.some((w) => (df.get(w) ?? 0) <= maxFrequency)) out.push(hitFor(item, 0.35));
    }
    return out;
  };
}

/** Only when the shipped retrieval found nothing by words: a second look that cannot add noise to a question already answered. */
export function onlyIfNothingMatched(widen: (hits: Hit[], query: RetrievalQuery) => Hit[]) {
  return (hits: Hit[], query: RetrievalQuery): Hit[] => (hits.some((h) => h.lexical > 0) ? hits : widen(hits, query));
}

/** The same candidates with the coverage bar lowered from a third of the question's words to a quarter. */
export function withLooserCoverage(store: MemoryStore, bar = 0.25) {
  return (hits: Hit[], query: RetrievalQuery): Hit[] => {
    const q = new Set(tokens(query.text));
    if (q.size === 0) return hits;
    const have = known(hits);
    const out = [...hits];
    for (const item of everything(store)) {
      if (have.has(item.id) || !query.scopes.some((s) => s.kind === item.scope.kind && s.key === item.scope.key)) continue;
      const t = new Set(tokens(item.text));
      const cover = [...q].filter((w) => t.has(w)).length / q.size;
      if (cover >= bar) out.push(hitFor(item, 0.3));
    }
    return out;
  };
}

// ---------------------------------------------------------------------------------------------- the set

export const VARIANTS: Record<string, Variant> = {
  "assistant as shipped": (s, i) => s.retrieve(i),
  "structured sets only": (s, i) => s.retrieveWith(i, (hits) => hits.filter((h) => h.lexical === 0)),
  "full text only": (s, i) => s.retrieveWith(i, (hits) => hits.filter((h) => h.lexical > 0)),
  "+ lexical expansion": (s, i) => s.retrieveWith(i, withExpansion(s, i.text)),
  "+ hashed vectors": (s, i) => s.retrieveWith(i, withVectors(s)),
  "+ identifier graph": (s, i) => s.retrieveWith(i, withGraph(s)),
  "+ one rare shared word": (s, i) => s.retrieveWith(i, withRareWords(s)),
  "+ looser coverage (a quarter)": (s, i) => s.retrieveWith(i, withLooserCoverage(s)),
  "+ expansion and vectors": (s, i) => s.retrieveWith(i, (hits, q) => withVectors(s)(withExpansion(s, i.text)(hits, q), q)),
  "+ expansion and one rare word": (s, i) => s.retrieveWith(i, (hits, q) => withRareWords(s)(withExpansion(s, i.text)(hits, q), q)),
  "+ one rare word, only if nothing matched": (s, i) => s.retrieveWith(i, onlyIfNothingMatched(withRareWords(s))),
  "+ expansion, only if nothing matched": (s, i) => s.retrieveWith(i, onlyIfNothingMatched(withExpansion(s, i.text))),
  "+ rare word then expansion, only if nothing matched": (s, i) =>
    s.retrieveWith(i, onlyIfNothingMatched((hits, q) => {
      const rare = withRareWords(s)(hits, q);
      return rare.some((h) => h.lexical > 0) ? rare : withExpansion(s, i.text)(hits, q);
    })),
};

// A real embedding model, when one is named: `ANCILLA_EVAL_EMBED_URL` (such as http://127.0.0.1:8792/v1), with
// `ANCILLA_EVAL_EMBED_MODEL` and, for models that want one, `ANCILLA_EVAL_EMBED_QUERY_PREFIX`. Nothing is called otherwise.
const EMBED_URL = process.env["ANCILLA_EVAL_EMBED_URL"];
if (EMBED_URL) {
  const model = process.env["ANCILLA_EVAL_EMBED_MODEL"] ?? "embedding";
  const prefix = process.env["ANCILLA_EVAL_EMBED_QUERY_PREFIX"] ?? "";
  for (const threshold of [0.45, 0.55, 0.65]) {
    VARIANTS[`+ meaning vectors (real model, cosine from ${threshold})`] = (s, i) => s.retrieveWith(i, withMeaning(s, EMBED_URL, model, prefix, threshold));
    VARIANTS[`+ meaning vectors (real model, cosine from ${threshold}), only if nothing matched`] = (s, i) => s.retrieveWith(i, onlyIfNothingMatched(withMeaning(s, EMBED_URL, model, prefix, threshold)));
  }
  for (const [threshold, most] of [[0.5, 1], [0.5, 2], [0.55, 1], [0.55, 2], [0.6, 2], [0.65, 2], [0.7, 2]] as const) {
    VARIANTS[`+ meaning vectors (real model, cosine from ${threshold}, the closest ${most})`] = (s, i) => s.retrieveWith(i, withMeaning(s, EMBED_URL, model, prefix, threshold, most));
  }
  // The nearest note when it stands out from the rest (nothing is added for a question every note is equally far from), alone and with the bar.
  for (const floor of [0.45, 0.5, 0.55]) {
    for (const gap of [0.05, 0.1, 0.15]) {
      VARIANTS[`+ meaning vectors (real model, the nearest when from ${floor} and ${gap} ahead)`] = (s, i) =>
        s.retrieveWith(i, withMeaningSelection(s, EMBED_URL, model, prefix, { bar: Infinity, floor, gap, most: 1 }));
    }
  }
  for (const floor of [0.45, 0.5, 0.55]) {
    for (const gap of [0.1, 0.15]) {
      VARIANTS[`+ meaning vectors (real model, from 0.65 or the nearest when from ${floor} and ${gap} ahead, the closest 2)`] = (s, i) =>
        s.retrieveWith(i, withMeaningSelection(s, EMBED_URL, model, prefix, { bar: 0.65, floor, gap, most: 2 }));
    }
  }
  // The settings the assistant starts from, so that a change to them cannot go unmeasured.
  const D = DEFAULT_EMBEDDING_SETTINGS;
  VARIANTS["+ meaning search as shipped (the default settings)"] = (s, i) =>
    s.retrieveWith(i, withMeaningSelection(s, EMBED_URL, model, prefix, { bar: D.minCosine, floor: D.standoutCosine ?? Infinity, gap: D.standoutLead, most: D.most }));
}
