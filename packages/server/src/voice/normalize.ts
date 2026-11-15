/**
 * Deterministic spoken-technical inverse text normalization (ITN) for English, Portuguese, and Spanish voice transcripts.
 *
 * Converts clearly dictated code/path/port/version constructs (such as `"packages slash server dot ts"`,
 * `"camel case voice session"`, `"port eighty eighty"`, `"one point zero"`) into their literal forms while leaving
 * ordinary conversational prose untouched.
 */

const FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonl",
  "md",
  "mdx",
  "py",
  "rs",
  "go",
  "toml",
  "yaml",
  "yml",
  "html",
  "css",
  "scss",
  "sql",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "env",
  "txt",
  "csv",
  "xml",
  "lock",
  "svelte",
  "vue",
  "astro",
  "plist",
  "db",
  "sqlite",
  "wasm",
  "onnx",
  "svg",
  "png",
]);

const PATH_DIR_HEADS = new Set([
  "src",
  "package",
  "packages",
  "apps",
  "app",
  "lib",
  "bin",
  "pkg",
  "core",
  "shared",
  "common",
  "client",
  "dist",
  "build",
  "test",
  "tests",
  "server",
  "ui",
  "daemon",
  "web",
  "desktop",
  "voice",
  "assistant",
  "providers",
  "components",
  "types",
  "utils",
  "hooks",
  "routes",
  "services",
  "workers",
  "engines",
  "model",
  "api",
  "public",
  "docs",
  "scripts",
  "config",
]);

const PROSE_SLASH_PAIRS = new Set([
  "and/or",
  "either/or",
  "yes/no",
  "no/yes",
  "true/false",
  "false/true",
  "pass/fail",
  "fail/pass",
  "pros/cons",
  "he/she",
  "she/he",
  "him/her",
  "his/her",
  "on/off",
  "off/on",
  "in/out",
  "up/down",
  "win/lose",
  "good/bad",
  "read/write",
  "before/after",
  "e/ou",
  "sim/nao",
  "verdadeiro/falso",
  "certo/errado",
  "pros/contras",
  "ele/ela",
  "dele/dela",
  "antes/depois",
  "y/o",
  "si/no",
  "verdadero/falso",
  "el/ella",
  "antes/despues",
]);

const PROSE_NON_PATH_TOKENS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "yes",
  "no",
  "true",
  "false",
  "e",
  "ou",
  "sim",
  "nao",
  "de",
  "do",
  "da",
  "dos",
  "das",
  "em",
  "na",
  "el",
  "la",
  "del",
  "al",
  "y",
  "o",
  "si",
  "lateral",
  "superior",
  "inferior",
  "vertical",
  "horizontal",
  "invertida",
  "espaciadora",
  "fixa",
  "fija",
  "e.g",
  "i.e",
  "a.m",
  "p.m",
  "v.s",
  "u.s",
  "u.k",
]);

const CASE_STOP_WORDS = new Set([
  "in",
  "on",
  "at",
  "to",
  "for",
  "from",
  "into",
  "inside",
  "with",
  "and",
  "or",
  "then",
  "please",
  "version",
  "versao",
  "versão",
  "versión",
  "port",
  "porta",
  "puerto",
  "flag",
  "option",
  "dot",
  "ponto",
  "punto",
  "slash",
  "barra",
  "colon",
  "equals",
  "is",
  "are",
  "was",
  "were",
  "no",
  "na",
  "em",
  "de",
  "do",
  "da",
  "para",
  "por",
  "com",
  "en",
  "con",
  "del",
  "al",
]);

const CLI_FLAG_PREFIXES = new Set([
  "no",
  "non",
  "without",
  "with",
  "disable",
  "enable",
  "allow",
  "disallow",
  "skip",
  "force",
  "dry",
  "save",
  "max",
  "min",
  "ignore",
  "strict",
  "auto",
  "only",
  "include",
  "exclude",
  "output",
  "input",
  "log",
  "config",
  "watch",
]);

const DIGIT_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  oh: 0,
  cero: 0,
  one: 1,
  um: 1,
  uma: 1,
  uno: 1,
  una: 1,
  two: 2,
  dois: 2,
  duas: 2,
  dos: 2,
  three: 3,
  tres: 3,
  "três": 3,
  four: 4,
  quatro: 4,
  cuatro: 4,
  five: 5,
  cinco: 5,
  six: 6,
  seis: 6,
  seven: 7,
  sete: 7,
  siete: 7,
  eight: 8,
  oito: 8,
  ocho: 8,
  nine: 9,
  nove: 9,
  nueve: 9,
  ten: 10,
  dez: 10,
  diez: 10,
  eleven: 11,
  onze: 11,
  once: 11,
  twelve: 12,
  doze: 12,
  doce: 12,
  thirteen: 13,
  treze: 13,
  trece: 13,
  fourteen: 14,
  quatorze: 14,
  catorze: 14,
  catorce: 14,
  fifteen: 15,
  quinze: 15,
  quince: 15,
  sixteen: 16,
  dezesseis: 16,
  dieciseis: 16,
  "dieciséis": 16,
  seventeen: 17,
  dezessete: 17,
  diecisiete: 17,
  eighteen: 18,
  dezoito: 18,
  dieciocho: 18,
  nineteen: 19,
  dezenove: 19,
  diecinueve: 19,
};

const TENS_WORDS: Readonly<Record<string, number>> = {
  twenty: 20,
  vinte: 20,
  veinte: 20,
  thirty: 30,
  trinta: 30,
  treinta: 30,
  forty: 40,
  quarenta: 40,
  cuarenta: 40,
  fifty: 50,
  cinquenta: 50,
  cincuenta: 50,
  sixty: 60,
  sessenta: 60,
  sesenta: 60,
  seventy: 70,
  setenta: 70,
  eighty: 80,
  oitenta: 80,
  ochenta: 80,
  ninety: 90,
  noventa: 90,
};

function parseVersionSegment(word: string): string | null {
  const clean = word.toLowerCase();
  if (/^\d{1,3}$/.test(clean)) return clean;
  const digit = DIGIT_WORDS[clean];
  if (digit !== undefined) return String(digit);
  const tens = TENS_WORDS[clean];
  if (tens !== undefined) return String(tens);
  return null;
}

function parseSpokenPortTokens(tokens: readonly string[]): { port: number; consumed: number } | null {
  if (tokens.length === 0) return null;
  const w = tokens.map((t) => t.toLowerCase().replace(/^[,.:-]+|[,.:-]+$/g, ""));
  if (/^\d{2,5}$/.test(w[0] ?? "")) {
    const n = Number(w[0]);
    if (n >= 80 && n <= 65535) return { port: n, consumed: 1 };
  }
  const d0 = DIGIT_WORDS[w[0] ?? ""];
  if (d0 !== undefined && d0 >= 1 && d0 <= 9 && (w[1] === "thousand" || w[1] === "mil")) {
    return { port: d0 * 1000, consumed: 2 };
  }

  const readTwoDigit = (at: number): { value: number; step: number } | null => {
    const first = w[at] ?? "";
    const tens = TENS_WORDS[first];
    if (tens !== undefined) {
      const next = w[at + 1] ?? "";
      if (next === "e" || next === "y") {
        const unit = DIGIT_WORDS[w[at + 2] ?? ""];
        if (unit !== undefined && unit >= 1 && unit <= 9) return { value: tens + unit, step: 3 };
      }
      const directUnit = DIGIT_WORDS[next];
      if (directUnit !== undefined && directUnit >= 1 && directUnit <= 9) {
        return { value: tens + directUnit, step: 2 };
      }
      return { value: tens, step: 1 };
    }
    const teen = DIGIT_WORDS[first];
    if (teen !== undefined && teen >= 10 && teen <= 19) return { value: teen, step: 1 };
    return null;
  };

  const high = readTwoDigit(0);
  if (high) {
    if (w[high.step] === "hundred") {
      const port = high.value * 100;
      if (port >= 1000 && port <= 65535) return { port, consumed: high.step + 1 };
    }
    const low = readTwoDigit(high.step);
    if (low) {
      const port = high.value * 100 + low.value;
      if (port >= 1000 && port <= 65535) return { port, consumed: high.step + low.step };
    }
    const zero = w[high.step];
    const unit = DIGIT_WORDS[w[high.step + 1] ?? ""];
    if ((zero === "oh" || zero === "zero" || zero === "cero") && unit !== undefined && unit >= 0 && unit <= 9) {
      const port = high.value * 100 + unit;
      if (port >= 1000 && port <= 65535) return { port, consumed: high.step + 2 };
    }
  }
  return null;
}

function applyCasingOperators(input: string): string {
  return input.replace(
    /\b(camel|pascal|snake|kebab)\s*case\s+([a-zA-Z0-9]+(?:\s+[a-zA-Z0-9]+){0,4})/gi,
    (_full, styleRaw: string, tailRaw: string) => {
      const style = styleRaw.toLowerCase();
      const rawParts = tailRaw.split(/\s+/);
      const taken: string[] = [];
      const leftover: string[] = [];
      let stopped = false;
      for (let i = 0; i < rawParts.length; i++) {
        const part = rawParts[i]!;
        if (!stopped && (i === 0 || !CASE_STOP_WORDS.has(part.toLowerCase()))) {
          taken.push(part.toLowerCase());
        } else {
          stopped = true;
          leftover.push(part);
        }
      }
      if (taken.length === 0) return _full;
      let formatted: string;
      if (style === "camel") {
        formatted = taken.map((w, idx) => (idx === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("");
      } else if (style === "pascal") {
        formatted = taken.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
      } else if (style === "snake") {
        formatted = taken.join("_");
      } else {
        formatted = taken.join("-");
      }
      return leftover.length > 0 ? `${formatted} ${leftover.join(" ")}` : formatted;
    },
  );
}

const DOTTED_PATH_TARGET_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*\.[a-zA-Z0-9]{1,6}$/;

function looksPathSegment(token: string, position: "left" | "right" = "left"): boolean {
  const clean = token.toLowerCase();
  if (PROSE_NON_PATH_TOKENS.has(clean)) return false;
  if (PATH_DIR_HEADS.has(clean)) return true;
  if (clean.includes("/") || clean.includes("_") || clean.includes("-")) return true;
  if (/^\.(?:env|gitignore|npmrc|eslintrc|prettierrc)$/.test(clean)) return true;
  const dotIdx = clean.lastIndexOf(".");
  if (dotIdx > 0 && FILE_EXTENSIONS.has(clean.slice(dotIdx + 1))) return true;
  if (position === "right" && DOTTED_PATH_TARGET_RE.test(token)) return true;
  return false;
}

function collapseSpokenPaths(input: string): string {
  // Multi-slash chains (a slash b slash c) qualify as paths unless they are prose alternatives or contain prose stopwords.
  let text = input.replace(
    /(?<![\p{L}\p{N}_./-])([a-zA-Z0-9_.-]*[a-zA-Z0-9_-])\s+(?:forward\s+slash|slash|barra)\s+([a-zA-Z0-9_.-]*[a-zA-Z0-9_-])\s+(?:forward\s+slash|slash|barra)\s+(\.?[a-zA-Z0-9_.-]*[a-zA-Z0-9_-])(?![\p{L}\p{N}_-])/giu,
    (full, a: string, b: string, c: string) => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      const cLower = c.toLowerCase();
      if (
        PROSE_NON_PATH_TOKENS.has(aLower) ||
        PROSE_NON_PATH_TOKENS.has(bLower) ||
        PROSE_NON_PATH_TOKENS.has(cLower)
      ) {
        return full;
      }
      const pair1 = `${aLower}/${bLower}`;
      const pair2 = `${bLower}/${cLower}`;
      if (PROSE_SLASH_PAIRS.has(pair1) || PROSE_SLASH_PAIRS.has(pair2)) return full;
      return `${a}/${b}/${c}`;
    },
  );
  let prev = "";
  while (prev !== text) {
    prev = text;
    text = text.replace(
      /(?<![\p{L}\p{N}_./-])([a-zA-Z0-9_./-]*[a-zA-Z0-9_/-])\s+(?:forward\s+slash|slash|barra)\s+(\.?[a-zA-Z0-9_./-]*[a-zA-Z0-9_/-])(?![\p{L}\p{N}_-])/giu,
      (full, left: string, right: string) => {
        const pair = `${left.toLowerCase()}/${right.toLowerCase()}`;
        if (PROSE_SLASH_PAIRS.has(pair)) return full;
        if (PROSE_NON_PATH_TOKENS.has(left.toLowerCase()) || PROSE_NON_PATH_TOKENS.has(right.toLowerCase())) return full;
        if (!looksPathSegment(left, "left") && !looksPathSegment(right, "right")) return full;
        return `${left}/${right}`;
      },
    );
  }
  return text;
}

export function normalizeSpokenTechnical(raw: string): string {
  if (!raw || raw.trim() === "") return raw;
  let text = raw;

  // 1. Casing operators ("camel case foo bar" -> "fooBar", "snake case amazonia river" -> "amazonia_river").
  text = applyCasingOperators(text);

  // 2. Spoken CLI flags ("dash dash preset" -> "--preset", "dash dash disable shell" -> "--disable-shell").
  text = text.replace(
    /\b(?:dash\s+dash|double\s+dash|menos\s+menos)\s+([a-zA-Z][a-zA-Z0-9-]*)(?:(?:\s+(?:dash|hyphen|h[ií]fen|tracinho)\s+|\s+)([a-zA-Z][a-zA-Z0-9-]*))?/gi,
    (full, nameRaw: string, secondRaw?: string) => {
      const first = nameRaw.toLowerCase();
      if (!secondRaw) return `--${first}`;
      const second = secondRaw.toLowerCase();
      const explicitConnector = /\s+(?:dash|hyphen|h[ií]fen|tracinho)\s+/i.test(full.slice(full.toLowerCase().indexOf(first) + first.length));
      if (explicitConnector) return `--${first}-${second}`;
      if (CLI_FLAG_PREFIXES.has(first) && !CASE_STOP_WORDS.has(second) && DIGIT_WORDS[second] === undefined && TENS_WORDS[second] === undefined) {
        return `--${first}-${second}`;
      }
      return `--${first} ${secondRaw}`;
    },
  );

  // 3. Spoken underscores between identifier tokens ("amazonia underscore river" -> "amazonia_river").
  let prev = "";
  while (prev !== text) {
    prev = text;
    text = text.replace(
      /\b([a-zA-Z0-9_]+)\s+(?:underscore|underline|sublinhado|guion\s+bajo|gui[oó]n\s+bajo)\s+([a-zA-Z0-9_]+)\b/gi,
      "$1_$2",
    );
  }

  // 4. Spoken hyphens inside multi-part technical slugs ("muse dash wonder dash full" -> "muse-wonder-full").
  prev = "";
  while (prev !== text) {
    prev = text;
    text = text.replace(
      /\b([a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*)\s+(?:hyphen|h[ií]fen|tracinho)\s+([a-zA-Z0-9]+)\b/gi,
      "$1-$2",
    );
  }

  // 5. Spoken dotfile & file extensions ("dot env" -> ".env", "server dot ts" -> "server.ts", "package ponto json" -> "package.json").
  text = text.replace(/\b(?:dot|ponto|punto)\s+(env|gitignore|npmrc|eslintrc|prettierrc)\b/gi, (_m, ext: string) => `.${ext.toLowerCase()}`);
  text = text.replace(
    /\b([a-zA-Z0-9_/-]+)\s+(?:dot|ponto|punto)\s+([a-zA-Z0-9]{1,8})\b/gi,
    (full, stem: string, ext: string) => {
      const lowerExt = ext.toLowerCase();
      if (!FILE_EXTENSIONS.has(lowerExt)) return full;
      return `${stem}.${lowerExt}`;
    },
  );

  // 6. Spoken slashes in file paths ("packages slash server slash src slash server.ts" -> "packages/server/src/server.ts").
  text = collapseSpokenPaths(text);

  // 7. Spoken numeric versions ("one point zero" -> "1.0", "two point zero point one" -> "2.0.1").
  const vTokens = text.split(/(\s+)/);
  const vOut: string[] = [];
  for (let i = 0; i < vTokens.length; ) {
    const tok = vTokens[i]!;
    if (/^\s+$/.test(tok)) {
      vOut.push(tok);
      i += 1;
      continue;
    }
    const cleanTok = tok.replace(/^[,;:()]+|[,;:()]+$/g, "");
    const firstSeg = parseVersionSegment(cleanTok);
    const sep1 = vTokens[i + 2]?.toLowerCase();
    const nextTokRaw = vTokens[i + 4] ?? "";
    const nextTokClean = nextTokRaw.replace(/[,.;:!?)]+$/g, "");
    const secondSeg = sep1 && /^(?:point|dot|ponto|punto)$/.test(sep1) ? parseVersionSegment(nextTokClean) : null;
    if (firstSeg !== null && secondSeg !== null) {
      const leadPunct = tok.slice(0, tok.indexOf(cleanTok));
      let trailPunct = nextTokRaw.slice(nextTokClean.length);
      const parts = [firstSeg, secondSeg];
      let cursor = i + 4;
      while (cursor + 4 < vTokens.length && trailPunct === "") {
        const sepMore = vTokens[cursor + 2]?.toLowerCase();
        const segRaw = vTokens[cursor + 4] ?? "";
        const segClean = segRaw.replace(/[,.;:!?)]+$/g, "");
        const parsed = sepMore && /^(?:point|dot|ponto|punto)$/.test(sepMore) ? parseVersionSegment(segClean) : null;
        if (parsed === null) break;
        parts.push(parsed);
        trailPunct = segRaw.slice(segClean.length);
        cursor += 4;
      }
      vOut.push(`${leadPunct}${parts.join(".")}${trailPunct}`);
      i = cursor + 1;
      continue;
    }
    vOut.push(tok);
    i += 1;
  }
  text = vOut.join("");

  // 8. Normalize "local host" -> "localhost" when followed by a port cue or number, then resolve spoken ports.
  text = text.replace(/\blocal\s+host\b(?=\s+(?:colon|port|porta|puerto|\d|three|five|eight|thirty|forty|fifty|eighty|tr[eê]s|cinco|oito|cinquenta|oitenta|tres|ocho|cincuenta|ochenta))/gi, "localhost");

  text = text.replace(
    /\b(localhost|127\.0\.0\.1|port|porta|puerto)(?:\s+(?:colon|dois\s+pontos|dos\s+puntos|:))?\s+([a-zA-Z0-9\u00C0-\u017F]+(?:\s+[a-zA-Z0-9\u00C0-\u017F]+){0,5})/gi,
    (full, headRaw: string, restRaw: string) => {
      const restWords = restRaw.split(/\s+/);
      const parsed = parseSpokenPortTokens(restWords);
      if (!parsed) return full;
      const tailToken = restWords[parsed.consumed - 1] ?? "";
      const trailingPunctMatch = /([,.;:!?)]+)$/.exec(tailToken);
      const trailingPunct = trailingPunctMatch ? trailingPunctMatch[1] : "";
      const remaining = restWords.slice(parsed.consumed);
      const isHost = /^(?:localhost|127\.0\.0\.1)$/i.test(headRaw);
      const formattedHead = isHost ? `${headRaw.toLowerCase()}:${parsed.port}${trailingPunct}` : `${headRaw} ${parsed.port}${trailingPunct}`;
      return remaining.length > 0 ? `${formattedHead} ${remaining.join(" ")}` : formattedHead;
    },
  );

  return text;
}
