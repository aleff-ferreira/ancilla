import { createHash } from "node:crypto";

/**
 * The small, deterministic text toolkit the assistant's memory is built on: normalisation for comparing, a light
 * stemmer, similarity, digests for deduplication and for recognising erased content, the exact identifiers a
 * statement contains, and a parser for the few ways people say when. Nothing here calls a model.
 */

export function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export const STOPWORDS = new Set(
  ("a an the and or but if then else of to in on at by for with from as is are was were be been being am do does did done have has had " +
    "i me my mine we us our you your it its this that these those there here so than too very can could should would will shall may might must " +
    "not no yes just also about into over under up down out off again more most some any all each other such only own same what which who whom " +
    "when where why how please thanks thank").split(" "),
);

/** Lower case, accents folded, and the odd quote marks made plain, so that two spellings of one thing compare equal. */
export function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();
}

/** A deliberately light stemmer: it merges the common inflections and leaves everything else alone. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ing") && w.length > 5) {
    w = w.slice(0, -3);
    if (/(.)\1$/.test(w) && !/(ss|ll|zz)$/.test(w)) w = w.slice(0, -1);
    return w;
  }
  if (w.endsWith("ed") && w.length > 4) {
    w = w.slice(0, -2);
    if (/(.)\1$/.test(w) && !/(ss|ll|zz)$/.test(w)) w = w.slice(0, -1);
    return w;
  }
  if (w.endsWith("es") && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  if (w.endsWith("ly") && w.length > 5) return w.slice(0, -2);
  return w;
}

/** `don't` becomes `do not` and `can't` `cannot`, so a negation is one word and never a stray `t`. */
export function expandContractions(text: string): string {
  return text
    .replace(/\bcan't\b/g, "cannot")
    .replace(/\bwon't\b/g, "will not")
    .replace(/\bshan't\b/g, "shall not")
    .replace(/\b(\w+)n't\b/g, "$1 not")
    .replace(/\b(\w+)'(?:ll|ve|re|d|m)\b/g, "$1");
}

const NEGATORS = new Set(["never", "not", "no", "avoid", "without", "stop", "cannot", "nothing", "none", "neither", "nor", "forbidden"]);

/** How many words of refusal a statement carries: an odd count means it says the opposite of an even one. */
export function negations(text: string): number {
  let n = 0;
  for (const word of expandContractions(fold(text)).split(/[^a-z]+/)) if (NEGATORS.has(word)) n += 1;
  return n;
}

/** The words of a text, stemmed, without the words that carry no meaning on their own. Identifiers stay whole. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of expandContractions(fold(text)).split(/[^a-z0-9._\-/\\@#:]+/)) {
    const word = raw.replace(/^[._\-/\\:]+|[._\-/\\:]+$/g, "");
    if (!word || STOPWORDS.has(word)) continue;
    out.push(/[._\-/\\@#:]/.test(word) ? word : stem(word));
  }
  return out;
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokens(text));
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let both = 0;
  for (const word of a) if (b.has(word)) both += 1;
  return both / (a.size + b.size - both);
}

/** How much of `a` is in `b`: 1 when every word of a short query appears in a long statement. */
export function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0) return 0;
  let both = 0;
  for (const word of a) if (b.has(word)) both += 1;
  return both / a.size;
}

/** Character trigrams of a folded word, for forgiving a typo. */
export function trigrams(word: string): Set<string> {
  const padded = `  ${fold(word)} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

/** A stable digest of what a text says, ignoring case, accents and spacing, so the same words are recognised again. */
export function digest(text: string): string {
  const norm = fold(text)
    .split(/[^a-z0-9._\-/\\@#:]+/)
    .map((word) => word.replace(/^[._\-/\\:]+|[._\-/\\:]+$/g, ""))
    .filter(Boolean)
    .join(" ");
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

/** What a tombstone stores in place of erased content: bound to a scope so a word forgotten in one project is not blocked in another. */
export function fingerprint(text: string, scope: string): string {
  return createHash("sha256").update(`${scope}\u0000${digest(text)}`).digest("hex").slice(0, 32);
}

const IDENTIFIER_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s)>\]"'`]+/g,
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /(?:[A-Za-z]:\\|~\/|\.{1,2}\/|\/)[\w@%+=.,\\/-]+/g,
  /\b[\w.-]+\/[\w./-]*\.[a-z0-9]{1,6}\b/gi,
  /\b[\w-]+\.(?:md|txt|json|jsonl|ts|tsx|js|mjs|cjs|py|rs|toml|yaml|yml|html|css|sql|sh|ps1|lock|csv|pdf|docx)\b/gi,
  /\bv?\d+\.\d+(?:\.\d+)*(?:-[\w.]+)?\b/g,
  /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g,
  /[$€£]\s?\d[\d,.]*/g,
  /\b\d+(?:[.,]\d+)?\s?(?:ms|sec|seconds?|min|minutes?|hours?|days?|weeks?|kb|mb|gb|tb|%|usd|eur|brl|tokens?)\b/gi,
  /`([^`\n]{1,80})`/g,
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g,
];

/** The exact strings in a statement that must survive any rewrite: paths, urls, ids, versions, amounts, quoted names. */
export function identifiersOf(text: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const raw = (match[1] ?? match[0]).replace(/[.,;:!?)\]]+$/, "");
      if (raw.length < 2 || seen.has(raw)) continue;
      seen.add(raw);
      found.push(raw);
    }
  }
  // Several patterns see parts of one identifier (docs/NOTES.md also reads as NOTES.md): only the whole is kept.
  return found.filter((id) => !found.some((other) => other !== id && other.length > id.length && other.includes(id)));
}

// ---------------------------------------------------------------------------------------------- when

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface When {
  at: number;
  matched: string;
}

/**
 * Reads when something is due from the way people say it: an ISO date, today, tomorrow, "in 3 days", "next friday",
 * "by march 3", "at 5pm". `offsetMinutes` is the local clock's distance east of UTC. A date without a time falls at
 * 09:00 local. Returns null when nothing is said, and never guesses.
 */
export function parseWhen(text: string, now: number, offsetMinutes = 0): When | null {
  const lower = fold(text);
  const shift = offsetMinutes * 60_000;
  const local = new Date(now + shift);
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const d = local.getUTCDate();
  const wd = local.getUTCDay();
  const make = (year: number, month: number, day: number, hour = 9, minute = 0): number => Date.UTC(year, month, day, hour, minute) - shift;

  let time: { hour: number; minute: number } | null = null;
  let timeText = "";
  const t = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(lower);
  if (t) {
    let hour = Number(t[1]);
    const minute = t[2] ? Number(t[2]) : 0;
    if (t[3] === "pm" && hour < 12) hour += 12;
    if (t[3] === "am" && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) {
      time = { hour, minute };
      timeText = t[0];
    }
  }
  const at = (year: number, month: number, day: number, fallbackHour = 9): number => make(year, month, day, time?.hour ?? fallbackHour, time?.minute ?? 0);
  const done = (value: number, matched: string): When => ({ at: value, matched: timeText && !matched.includes(timeText) ? `${matched} ${timeText}` : matched });

  let m = /\b(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{1,2}):(\d{2}))?\b/.exec(lower);
  if (m) {
    const hour = m[4] !== undefined ? Number(m[4]) : time?.hour ?? 9;
    const minute = m[5] !== undefined ? Number(m[5]) : time?.minute ?? 0;
    return { at: make(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute), matched: m[0] };
  }
  m = /\bin\s+(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(minute|hour|day|week|month)s?\b/.exec(lower);
  if (m) {
    const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const n = /^\d+$/.test(m[1] as string) ? Number(m[1]) : (words[m[1] as string] ?? 1);
    const unit = { minute: 60_000, hour: HOUR, day: DAY, week: 7 * DAY, month: 30 * DAY }[m[2] as "minute"];
    return { at: now + n * unit, matched: m[0] };
  }
  if (/\bday after tomorrow\b/.test(lower)) return done(at(y, mo, d + 2), "day after tomorrow");
  if (/\btomorrow\b/.test(lower)) return done(at(y, mo, d + 1), "tomorrow");
  if (/\btonight\b/.test(lower)) return done(at(y, mo, d, 20), "tonight");
  if (/\btoday\b/.test(lower)) return done(at(y, mo, d, 17), "today");
  m = /\bnext\s+(week|month|year)\b/.exec(lower);
  if (m) {
    if (m[1] === "week") return done(at(y, mo, d + 7), m[0]);
    if (m[1] === "month") return done(at(y, mo + 1, d), m[0]);
    return done(at(y + 1, mo, d), m[0]);
  }
  m = /\bend of (?:the )?(day|week|month)\b/.exec(lower);
  if (m) {
    if (m[1] === "day") return done(at(y, mo, d, 17), m[0]);
    if (m[1] === "week") return done(at(y, mo, d + ((5 - wd + 7) % 7), 17), m[0]);
    return done(at(y, mo + 1, 0, 17), m[0]);
  }
  m = new RegExp(`\\b(?:next\\s+|on\\s+|by\\s+|this\\s+)?(${DAYS.join("|")})\\b`).exec(lower);
  if (m) {
    const target = DAYS.indexOf(m[1] as string);
    const ahead = (target - wd + 7) % 7 || 7;
    return done(at(y, mo, d + ahead), m[0]);
  }
  m = new RegExp(`\\b(${MONTHS.map((x) => x.slice(0, 3)).join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(lower);
  if (m) {
    const month = MONTHS.findIndex((x) => x.startsWith(m![1] as string));
    const day = Number(m[2]);
    if (day >= 1 && day <= 31) {
      let when = at(y, month, day);
      if (when < now) when = at(y + 1, month, day);
      return done(when, m[0]);
    }
  }
  if (time) return done(at(y, mo, d) < now ? at(y, mo, d + 1) : at(y, mo, d), timeText);
  return null;
}
