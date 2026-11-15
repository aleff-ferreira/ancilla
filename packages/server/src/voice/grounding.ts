import { isBackchannel, isStopIntent } from "./text.js";

/**
 * Dynamic active-vocabulary phonetic grounder for voice ASR turns.
 *
 * Reconciles streaming and offline ASR hypotheses against entities currently active in the user's Ancilla session
 * (persona name, user name, catalog/active model slugs, project names, workspace filenames, active tasks) across
 * three tiers:
 *   - Tier A: Dual-hypothesis reconciliation (`streamingText` heard the exact vocabulary entity while `text` has a near-miss).
 *   - Tier B: Confidence-gated phonetic substitution (`similarity >= 0.84`, or `>= 0.76` with low token log-prob).
 *   - Tier C: Non-destructive candidate context note (`0.58 <= similarity < threshold`) so the model sees likely UI matches
 *     without rewriting ambiguous prose.
 */

export interface GroundingInput {
  text: string;
  streamingText?: string | undefined;
  tokens?: readonly string[] | undefined;
  tokenLogProbs?: readonly number[] | undefined;
  vocabulary: readonly string[];
}

export interface GroundingOutput {
  text: string;
  groundedEntities: string[];
  candidateNote: string | null;
  meanLogProb: number | null;
  minLogProb: number | null;
  garbled: boolean;
}

const VOWELS = new Set(["a", "e", "i", "o", "u"]);

/** Common single-word prose tokens that must never be rewritten on their own into proper nouns/slugs. */
const PROTECTED_SINGLE_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "what", "when", "where", "which", "who", "how", "why",
  "glad", "news", "wonderful", "spark", "full", "muse", "server", "voice", "main", "test", "tests", "index", "app",
  "call", "calls", "store", "turn", "turns", "text", "time", "open", "read", "list", "start", "stop", "run", "task",
  "tasks", "file", "files", "code", "model", "models", "user", "name", "river", "notes", "page", "site", "port",
  "panel", "host", "brain", "tools", "prompt", "service", "session", "status", "check", "make", "good", "well",
  "para", "como", "onde", "qual", "isso", "esse", "esta", "este", "voce", "agora", "hoje", "tudo", "bem", "bom",
  "sobre", "abrir", "rodar", "falar", "usar", "qual", "quais", "donde", "esta", "esto", "todo", "bien", "bueno",
]);

const FUNCTION_WORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "by", "with", "from", "is", "are", "was", "were", "be",
  "and", "or", "but", "if", "it", "my", "our", "your", "o", "os", "as", "um", "uma", "de", "do", "da", "dos", "das",
  "em", "no", "na", "nos", "nas", "por", "para", "com", "el", "la", "los", "las", "un", "una", "del", "al", "en", "con",
]);

function foldAscii(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Maps a word or phrase to a compact cross-lingual phonetic skeleton. */
export function phoneticSkeleton(raw: string): string {
  let s = foldAscii(raw).replace(/[^a-z0-9]+/g, "");
  if (s === "") return "";
  s = s
    .replace(/ph/g, "f")
    .replace(/th/g, "d")
    .replace(/ght/g, "t")
    .replace(/ck/g, "k")
    .replace(/qu/g, "k")
    .replace(/^kn/g, "n")
    .replace(/^wr/g, "r")
    .replace(/ew/g, "u")
    .replace(/oo/g, "u")
    .replace(/ee/g, "i")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/([bcdfghjklmnpqrstvwxys])\1+/g, "$1");
  return s;
}

function substCost(a: string, b: string): number {
  if (a === b) return 0;
  if (VOWELS.has(a) && VOWELS.has(b)) return 0.35;
  if ((a === "m" && b === "n") || (a === "n" && b === "m")) return 0.45;
  if ((a === "t" && b === "d") || (a === "d" && b === "t")) return 0.45;
  if ((a === "p" && b === "b") || (a === "b" && b === "p")) return 0.45;
  if ((a === "k" && b === "g") || (a === "g" && b === "k")) return 0.45;
  if ((a === "f" && b === "v") || (a === "v" && b === "f")) return 0.45;
  if ((a === "w" && b === "v") || (a === "v" && b === "w")) return 0.45;
  if ((a === "s" && b === "x") || (a === "x" && b === "s")) return 0.5;
  if ((a === "l" && b === "r") || (a === "r" && b === "l")) return 0.55;
  if ((a === "d" && b === "l") || (a === "l" && b === "d")) return 0.6;
  return 1;
}

export function phoneticSimilarity(aRaw: string, bRaw: string): number {
  const a = phoneticSkeleton(aRaw);
  const b = phoneticSkeleton(bRaw);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  const minLen = Math.min(a.length, b.length);
  if (minLen / maxLen < 0.45) return 0;

  const prev = new Float64Array(b.length + 1);
  const curr = new Float64Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a[i - 1]!;
    for (let j = 1; j <= b.length; j++) {
      const cb = b[j - 1]!;
      const del = prev[j]! + 1;
      const ins = curr[j - 1]! + 1;
      const sub = prev[j - 1]! + substCost(ca, cb);
      curr[j] = Math.min(del, ins, sub);
    }
    prev.set(curr);
  }
  const dist = prev[b.length]!;
  return Math.max(0, Number((1 - dist / maxLen).toFixed(4)));
}

interface VocabTarget {
  canonical: string;
  matchForm: string;
  skeleton: string;
  wordCount: number;
}

function buildTargets(vocabulary: readonly string[]): VocabTarget[] {
  const seen = new Set<string>();
  const targets: VocabTarget[] = [];
  const add = (canonical: string, matchForm: string): void => {
    const skeleton = phoneticSkeleton(matchForm);
    if (skeleton.length < 5) return;
    const key = `${canonical.toLowerCase()}::${skeleton}`;
    if (seen.has(key)) return;
    seen.add(key);
    const wordCount = Math.max(1, matchForm.split(/[-_./\s]+/).filter(Boolean).length);
    targets.push({ canonical, matchForm, skeleton, wordCount });
  };

  for (const raw of vocabulary) {
    const entry = raw.trim();
    if (entry.length < 5) continue;
    add(entry, entry);
    // Also index the versionless stem of hyphenated model ids (e.g. "muse-wonder-full" for "muse-wonder-full-1.0")
    // unless that stem is itself a separate entry in `vocabulary`.
    const stemMatch = /^([a-zA-Z][a-zA-Z0-9]*(?:[-_][a-zA-Z0-9]+)+?)[-_]v?\d+(?:\.\d+)*$/.exec(entry);
    if (stemMatch) {
      const stem = stemMatch[1]!;
      const stemExistsAlone = vocabulary.some((v) => v.trim().toLowerCase() === stem.toLowerCase());
      if (!stemExistsAlone) add(entry, stem);
    }
  }
  return targets;
}

interface WordSpan {
  wordStart: number;
  wordEnd: number;
  charStart: number;
  charEnd: number;
  raw: string;
  words: string[];
}

function extractWords(text: string): Array<{ word: string; start: number; end: number }> {
  const out: Array<{ word: string; start: number; end: number }> = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const clean = m[0].replace(/[.,;:!?)]+$/, "");
    if (!clean) continue;
    out.push({ word: clean, start: m.index, end: m.index + clean.length });
  }
  return out;
}

function normalizeLogProbs(probs?: readonly number[]): number[] {
  if (!probs || probs.length === 0) return [];
  const out: number[] = [];
  for (const p of probs) {
    if (!Number.isFinite(p)) continue;
    if (p > 0 && p <= 1) out.push(Math.log(Math.max(p, 1e-9)));
    else if (p <= 0) out.push(p);
  }
  return out;
}

function containsExactEntity(haystack: string, entity: string): boolean {
  const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(haystack);
}

export function groundUtterance(input: GroundingInput): GroundingOutput {
  const logProbs = normalizeLogProbs(input.tokenLogProbs);
  const meanLogProb = logProbs.length > 0 ? logProbs.reduce((a, b) => a + b, 0) / logProbs.length : null;
  const minLogProb = logProbs.length > 0 ? Math.min(...logProbs) : null;

  const trimmed = input.text.trim();
  const initialWords = extractWords(trimmed);
  const garbled =
    initialWords.length > 0 &&
    initialWords.length < 3 &&
    meanLogProb !== null &&
    meanLogProb < -1.85 &&
    !isStopIntent(trimmed) &&
    !isBackchannel(trimmed);

  if (trimmed === "" || input.vocabulary.length === 0) {
    return {
      text: input.text,
      groundedEntities: [],
      candidateNote: null,
      meanLogProb,
      minLogProb,
      garbled,
    };
  }

  const targets = buildTargets(input.vocabulary);
  if (targets.length === 0) {
    return {
      text: input.text,
      groundedEntities: [],
      candidateNote: null,
      meanLogProb,
      minLogProb,
      garbled,
    };
  }

  let working = input.text;
  const groundedEntities: string[] = [];

  // Tier A: Dual-hypothesis reconciliation when `streamingText` captured the exact vocabulary token.
  const streaming = (input.streamingText ?? "").trim();
  if (streaming !== "") {
    for (const target of targets) {
      if (containsExactEntity(working, target.canonical)) continue;
      if (!containsExactEntity(streaming, target.canonical) && !containsExactEntity(streaming, target.matchForm)) continue;
      const words = extractWords(working);
      const maxN = Math.min(5, Math.max(3, target.wordCount + 2));
      let bestSpan: WordSpan | null = null;
      let bestSim = 0;
      for (let n = 1; n <= maxN; n++) {
        for (let i = 0; i + n <= words.length; i++) {
          const wStart = words[i]!;
          const wEnd = words[i + n - 1]!;
          const rawSpan = working.slice(wStart.start, wEnd.end);
          const sim = phoneticSimilarity(rawSpan, target.matchForm);
          if (sim >= 0.68 && sim > bestSim) {
            bestSim = sim;
            bestSpan = {
              wordStart: i,
              wordEnd: i + n - 1,
              charStart: wStart.start,
              charEnd: wEnd.end,
              raw: rawSpan,
              words: words.slice(i, i + n).map((x) => x.word),
            };
          }
        }
      }
      if (bestSpan) {
        working = `${working.slice(0, bestSpan.charStart)}${target.canonical}${working.slice(bestSpan.charEnd)}`;
        if (!groundedEntities.includes(target.canonical)) groundedEntities.push(target.canonical);
      }
    }
  }

  // Tier B & Tier C: Scan non-overlapping 1..5 word spans against active vocabulary targets.
  const words = extractWords(working);
  interface MatchCandidate {
    span: WordSpan;
    target: VocabTarget;
    sim: number;
    tier: "B" | "C";
  }

  const tierBThreshold = minLogProb !== null && minLogProb < -0.35 ? 0.76 : 0.84;
  const candidates: MatchCandidate[] = [];

  for (let n = 1; n <= Math.min(5, words.length); n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const slice = words.slice(i, i + n);
      const firstLower = foldAscii(slice[0]!.word);
      const lastLower = foldAscii(slice[slice.length - 1]!.word);
      // Do not allow spans that start or end with pure articles/prepositions unless internal to a phonetic match.
      if (n > 1 && (FUNCTION_WORDS.has(firstLower) || FUNCTION_WORDS.has(lastLower))) continue;
      if (n === 1 && (FUNCTION_WORDS.has(firstLower) || PROTECTED_SINGLE_WORDS.has(firstLower))) continue;
      if (slice.every((w) => FUNCTION_WORDS.has(foldAscii(w.word)))) continue;

      const charStart = slice[0]!.start;
      const charEnd = slice[slice.length - 1]!.end;
      const rawSpan = working.slice(charStart, charEnd);
      if (rawSpan.length < 4) continue;

      for (const target of targets) {
        if (rawSpan === target.canonical) continue;
        // Guard against matching a multi-word target onto an unrelated 1-word span unless collapsed length matches closely.
        const maxAllowedWords = Math.max(3, target.wordCount + 2);
        if (n > maxAllowedWords) continue;
        // Prevent "glad you" ("gladyou") from matching "GlaDOS" while allowing "Glad us" ("gladus") -> "GlaDOS".
        if (n === 2 && target.wordCount === 1 && slice[1]!.word.toLowerCase() === "you") continue;

        const sim = phoneticSimilarity(rawSpan, target.matchForm);
        if (sim >= tierBThreshold) {
          candidates.push({
            span: { wordStart: i, wordEnd: i + n - 1, charStart, charEnd, raw: rawSpan, words: slice.map((x) => x.word) },
            target,
            sim,
            tier: "B",
          });
        } else if (sim >= 0.58 && (n >= 2 || rawSpan.length >= 6)) {
          // Tier C: ambiguous candidate worth surfacing in context notes without rewriting user text.
          if (n >= 2 && slice.every((w) => PROTECTED_SINGLE_WORDS.has(foldAscii(w.word)))) continue;
          candidates.push({
            span: { wordStart: i, wordEnd: i + n - 1, charStart, charEnd, raw: rawSpan, words: slice.map((x) => x.word) },
            target,
            sim,
            tier: "C",
          });
        }
      }
    }
  }

  // Prefer Tier B over Tier C, higher similarity, and tighter span coverage.
  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "B" ? -1 : 1;
    if (Math.abs(b.sim - a.sim) > 0.015) return b.sim - a.sim;
    return (b.span.wordEnd - b.span.wordStart) - (a.span.wordEnd - a.span.wordStart);
  });

  const usedWords = new Set<number>();
  const replacements: MatchCandidate[] = [];
  const tierCCandidates: MatchCandidate[] = [];

  for (const cand of candidates) {
    let overlaps = false;
    for (let w = cand.span.wordStart; w <= cand.span.wordEnd; w++) {
      if (usedWords.has(w)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;
    if (containsExactEntity(working, cand.target.canonical) && cand.tier === "C") continue;
    for (let w = cand.span.wordStart; w <= cand.span.wordEnd; w++) usedWords.add(w);
    if (cand.tier === "B") {
      replacements.push(cand);
    } else if (tierCCandidates.length < 3) {
      tierCCandidates.push(cand);
    }
  }

  // Apply Tier B replacements right-to-left so character offsets stay valid.
  replacements.sort((a, b) => b.span.charStart - a.span.charStart);
  for (const rep of replacements) {
    // Check if an immediately following version token like "1.0" is already present when canonical ends with "-1.0".
    const versionTail = /[-_](\d+(?:\.\d+)+)$/.exec(rep.target.canonical);
    let endOffset = rep.span.charEnd;
    if (versionTail) {
      const after = working.slice(endOffset);
      const dupVer = new RegExp(`^\\s+${versionTail[1]!.replace(/\./g, "\\.")}\\b`).exec(after);
      if (dupVer) endOffset += dupVer[0].length;
    }
    working = `${working.slice(0, rep.span.charStart)}${rep.target.canonical}${working.slice(endOffset)}`;
    if (!groundedEntities.includes(rep.target.canonical)) groundedEntities.push(rep.target.canonical);
  }

  let candidateNote: string | null = null;
  if (tierCCandidates.length > 0) {
    const pairs = tierCCandidates.map((c) => `"${c.span.raw}" ≈ "${c.target.canonical}"`);
    candidateNote = `[ASR phonetic candidates against active UI entities: ${pairs.join("; ")}]`;
    for (const c of tierCCandidates) {
      if (!groundedEntities.includes(c.target.canonical)) groundedEntities.push(c.target.canonical);
    }
  }

  return {
    text: working,
    groundedEntities,
    candidateNote,
    meanLogProb,
    minLogProb,
    garbled,
  };
}
