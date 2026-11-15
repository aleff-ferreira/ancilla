/**
 * The words of a voice call: what is worth saying aloud, how a streaming reply is cut into sentences a speech engine can
 * start on at once, and what a few heard words say about whether the person has finished. Everything here is a pure
 * function of text, in English, Brazilian Portuguese, and Spanish, so it can be tested without any audio.
 */

export type Lang = "en" | "pt" | "es" | "unknown";

const PT_WORDS = new Set([
  "e", "é", "o", "os", "as", "um", "uma", "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas", "que", "para", "pra", "com", "não", "nao", "sim",
  "eu", "você", "voce", "ele", "ela", "nós", "vocês", "meu", "minha", "seu", "sua", "isso", "isto", "esse", "essa", "este", "esta", "aqui", "ali",
  "mas", "ou", "porque", "quando", "como", "onde", "quem", "qual", "quais", "também", "tambem", "já", "ja", "muito", "mais", "menos", "bem", "então", "entao",
  "obrigado", "obrigada", "olá", "ola", "bom", "boa", "dia", "tarde", "noite", "por", "favor", "pode", "poderia", "quero", "preciso", "tenho", "está",
  "são", "sao", "foi", "ser", "ter", "fazer", "vai", "vou", "vamos", "tudo", "nada", "algo", "hoje", "amanhã", "amanha", "ontem", "agora", "depois",
  "roda", "abre", "cria", "corrige", "testa", "mostra", "verifica", "checa",
]);

const EN_WORDS = new Set([
  "the", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "is", "are", "was", "were", "be", "been", "it", "this", "that", "these",
  "those", "i", "you", "he", "she", "we", "they", "my", "your", "his", "her", "our", "their", "me", "do", "does", "did", "have", "has", "had", "not",
  "yes", "what", "when", "where", "who", "why", "how", "which", "can", "could", "would", "should", "will", "shall", "please", "thanks", "thank", "hello",
  "hi", "just", "so", "if", "then", "there", "here", "now", "today", "tomorrow", "yesterday", "about", "from", "by", "as", "up", "out", "some", "any",
  "fix", "run", "build", "test", "open", "check", "read", "start", "stop", "deploy", "commit", "search",
]);

const ES_WORDS = new Set([
  "el", "la", "los", "las", "un", "una", "del", "al", "en", "con", "sin", "pero", "porque", "cuando", "donde", "dónde", "quien", "quién", "cual", "cuál",
  "cuales", "cuáles", "qué", "cómo", "cuánto", "cuántos", "yo", "tú", "tu", "usted", "ustedes", "él", "ella", "nosotros", "mi", "mis", "tus", "sus",
  "esto", "eso", "aquel", "aquí", "allí", "ahí", "también", "muy", "más", "bien", "entonces", "gracias", "hola", "buenos", "buenas", "días", "tardes",
  "noches", "puede", "puedes", "puedo", "podría", "quiero", "necesito", "tengo", "tienes", "tiene", "están", "estoy", "son", "fue", "hacer", "voy",
  "todo", "hoy", "mañana", "ayer", "ahora", "después", "sí", "vale", "ejecuta", "revisa", "crea", "arregla", "prueba", "muestra", "busca",
]);

/** Lower-cased words, without punctuation. Letters keep their accents; apostrophes stay inside a word. */
export function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? []).map((w) => w.replace(/’/g, "'"));
}

/** A guess of the language of a few words: the one whose own common words they hold more of. Ties are "unknown". */
export function guessLanguage(text: string): Lang {
  const words = wordsOf(text);
  if (words.length === 0) return "unknown";
  let pt = 0;
  let en = 0;
  let es = 0;
  for (const w of words) {
    const inPt = PT_WORDS.has(w);
    const inEn = EN_WORDS.has(w);
    const inEs = ES_WORDS.has(w);
    const count = (inPt ? 1 : 0) + (inEn ? 1 : 0) + (inEs ? 1 : 0);
    if (count === 1) {
      if (inPt) pt++;
      else if (inEn) en++;
      else if (inEs) es++;
    } else if (count === 2 && !inEn) {
      // Romance overlap when neither is English: nudge both equally so orthography or other words break the tie.
      if (inPt) pt += 0.5;
      if (inEs) es += 0.5;
    }
  }
  pt += Math.min(3, (text.match(/[ãõçâêôà]/gi) ?? []).length);
  es += Math.min(3, (text.match(/[ñ¿¡]/gi) ?? []).length);
  const acute = Math.min(3, (text.match(/[áéíóú]/gi) ?? []).length);
  if (acute > 0) {
    if (es > pt) es += acute;
    else pt += acute;
  }
  const best = Math.max(pt, en, es);
  if (best < 1) return "unknown";
  const winners = (pt === best ? 1 : 0) + (en === best ? 1 : 0) + (es === best ? 1 : 0);
  if (winners > 1) return "unknown";
  if (pt === best) return "pt";
  if (es === best) return "es";
  return "en";
}

/** Whether a single utterance mixes distinct English and Romance (Portuguese/Spanish) words (natural bilingual code-switching). */
export function hasCodeSwitch(text: string): boolean {
  const words = wordsOf(text);
  if (words.length < 3) return false;
  let romance = 0;
  let en = 0;
  for (const w of words) {
    const inRomance = PT_WORDS.has(w) || ES_WORDS.has(w);
    const inEn = EN_WORDS.has(w);
    if (inRomance && !inEn) romance++;
    else if (inEn && !inRomance) en++;
  }
  return romance >= 1 && en >= 1;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the person said: backchannels, stop words and whether they are done.

const BACKCHANNELS = new Set([
  // English
  "yeah", "yes", "yep", "yup", "ok", "okay", "uh-huh", "uh huh", "mm-hm", "mm hm", "mhm", "mmhm", "mm", "hmm", "right", "sure", "got it", "i see", "cool", "nice", "wow", "alright", "all right", "gotcha", "true", "exactly",
  // Portuguese
  "sim", "tá", "ta", "tá bom", "aham", "uhum", "uhm", "hum", "certo", "entendi", "legal", "beleza", "ah", "ahn", "claro", "sei", "verdade", "isso", "é", "pois é", "tranquilo",
  // Spanish
  "sí", "ajá", "aja", "vale", "entiendo", "entendido", "dale", "exacto", "bueno", "ya veo",
]);

function normalise(text: string): string {
  return text.toLowerCase().replace(/[.,!?;:…"]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Short sounds of listening ("mm-hm", "yeah", "aham") that are not an attempt to take the turn. */
export function isBackchannel(text: string): boolean {
  const cleaned = normalise(text);
  if (cleaned === "") return false;
  const words = cleaned.split(" ");
  if (words.length > 3) return false;
  return BACKCHANNELS.has(cleaned) || words.every((w) => BACKCHANNELS.has(w));
}

const STOP_PHRASES = [
  "stop", "wait", "hold on", "hang on", "one second", "one sec", "pause", "cancel that", "never mind", "nevermind", "be quiet", "enough", "that's enough", "hold up", "excuse me", "sorry", "actually",
  "pare", "para", "espera", "espere", "calma", "peraí", "pera aí", "perai", "um segundo", "só um segundo", "só um minuto", "cancela", "cancele", "esquece", "deixa pra lá", "chega", "silêncio", "desculpa", "desculpe", "na verdade",
  "detente", "aguarda", "un segundo", "un momento", "olvídalo", "olvidalo", "basta", "silencio", "disculpa", "perdón", "perdon", "en realidad",
];

/** Words that mean "stop talking" whatever else is said: they interrupt at once, even when they are few. */
export function isStopIntent(text: string): boolean {
  const cleaned = normalise(text);
  if (cleaned === "") return false;
  const padded = ` ${cleaned} `;
  const count = cleaned.split(" ").length;
  return STOP_PHRASES.some((phrase) => padded.includes(` ${phrase} `) && count <= phrase.split(" ").length + 4);
}

const COMMAND_WORDS = new Set([
  "stop", "yes", "no", "yeah", "nope", "cancel", "pause", "resume", "continue", "go", "next", "back", "repeat", "louder", "quieter", "mute",
  "sim", "não", "nao", "pare", "cancele", "cancela", "continua", "próximo", "proximo", "repete", "repita", "silêncio",
  "sí", "detente", "pausa", "continúa", "siguiente", "repite", "silencio",
]);

const CONTINUATION_EN = new Set([
  "and", "but", "or", "so", "because", "cause", "if", "when", "while", "that", "which", "who", "whom", "whose", "with", "without", "to", "of", "the", "a", "an",
  "my", "your", "his", "her", "its", "our", "their", "for", "in", "on", "at", "about", "from", "by", "as", "than", "then", "also", "plus", "like", "such",
  "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "have", "has", "had", "will", "would", "can", "could", "should", "shall", "may", "might",
  "not", "any", "some", "each", "every", "other", "another", "into", "onto", "over", "under", "between", "through", "during", "before", "after", "since",
  "until", "unless", "although", "though", "whether", "what", "where", "why", "how", "i", "we", "you", "they", "it", "this", "these", "those", "well",
]);

const CONTINUATION_PT = new Set([
  "e", "mas", "ou", "então", "entao", "porque", "porquê", "que", "se", "quando", "enquanto", "com", "sem", "para", "pra", "de", "do", "da", "dos", "das", "o", "a", "os", "as",
  "um", "uma", "uns", "umas", "meu", "minha", "meus", "minhas", "seu", "sua", "seus", "suas", "no", "na", "nos", "nas", "em", "por", "pelo", "pela", "sobre", "entre",
  "até", "ate", "depois", "antes", "tipo", "também", "tambem", "além", "alem", "como", "qual", "quais", "onde", "quem", "quanto", "quanta", "é", "são", "sao", "foi",
  "era", "ser", "estar", "está", "estou", "tem", "tenho", "vai", "vou", "vamos", "posso", "pode", "poderia", "deve", "devo", "eu", "nós", "você", "voce",
  "ele", "ela", "isso", "isto", "esse", "essa", "este", "aquele", "aquela", "já", "ja", "ainda", "mais", "menos", "muito", "bem", "só", "so", "ao", "aos", "à", "assim", "aí", "ai", "digamos",
]);

const CONTINUATION_ES = new Set([
  "y", "e", "pero", "o", "u", "entonces", "porque", "que", "si", "cuando", "mientras", "con", "sin", "para", "por", "de", "del", "al", "el", "la", "los", "las",
  "un", "una", "unos", "unas", "mi", "mis", "tu", "tus", "su", "sus", "en", "sobre", "entre", "hasta", "después", "antes", "como", "cual", "cuál", "donde",
  "dónde", "quien", "quién", "es", "son", "fue", "era", "ser", "estar", "está", "estoy", "tiene", "tengo", "va", "voy", "vamos", "puedo", "puede", "puedes",
  "podría", "debe", "yo", "nosotros", "tú", "usted", "él", "ella", "esto", "eso", "este", "esta", "ese", "esa", "ya", "aún", "más", "menos", "muy", "pues", "o sea",
]);

/** Sounds people make while they think: whatever follows them, the turn is not over. */
const SOUND_FILLERS = new Set(["uh", "um", "umm", "uhh", "er", "erm", "hmm", "hm", "mm", "ah", "ahn", "eh", "ehh", "éé", "ééé", "hã", "hum", "humm", "ahm", "ãh", "este..."]);
/** Words that are fillers when they trail off, but can also end a sentence ("I think so."). */
const WORD_FILLERS = new Set(["like", "well", "so", "tipo", "né", "ne", "então", "entao", "assim", "aí", "ai", "digamos", "pues", "bueno"]);
/** Trailing self-correction pivots ("send it to staging wait no", "às três quer dizer"): the speaker is mid-repair. */
const REPAIR_TRAIL_WORDS = new Set(["actually", "wait", "digo", "aliás", "alias", "espera", "peraí", "perai"]);
const REPAIR_TRAIL_PAIRS = new Set([
  "wait no", "no wait", "i mean", "or rather", "scratch that", "make that",
  "quer dizer", "ou melhor", "na verdade", "pera aí", "não espera", "nao espera",
  "es decir", "o sea", "mejor dicho", "en realidad", "no espera",
]);
/** Leading question words for recognizing syntactically complete unpunctuated questions from streaming ASR. */
const QUESTION_HEADS = new Set([
  "what", "whats", "what's", "where", "when", "who", "how", "which", "why",
  "qual", "quais", "quando", "onde", "como", "quem", "quanto", "quanta", "cadê", "cade",
  "qué", "cual", "cuál", "cuáles", "cuándo", "dónde", "cómo", "quién", "cuánto", "cuánta",
]);
/** Auxiliary/modal heads that form unpunctuated yes/no questions when followed by a complete predicate (>= 3 words). */
const AUX_QUESTION_HEADS = new Set([
  "are", "is", "do", "does", "did", "can", "could", "will", "would", "should", "have", "has",
  "pode", "poderia", "consegue", "está", "tá", "será", "já",
  "puedes", "puede", "podrías", "tienes", "tiene",
]);
const QUESTION_TAG_WORDS = new Set(["right", "né", "certo", "verdad"]);
const QUESTION_TAG_PAIRS = new Set(["isn't it", "don't you", "aren't you", "não é", "nao é", "no es", "verdad que"]);

const NUMBER_WORDS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "oh",
  "dois", "duas", "três", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "catorze", "quinze", "vinte", "trinta", "quarenta",
  "cinquenta", "sessenta", "setenta", "oitenta", "noventa", "cem", "cento",
  "uno", "dos", "cuatro", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "veinte", "treinta", "cuarenta", "cincuenta", "cien", "ciento",
]);

export type Completeness = "complete" | "incomplete" | "unknown";

export interface CompletenessReading {
  verdict: Completeness;
  /** Why, for tests and for the trace. */
  why: string;
  /** A short command ("stop", "yes"): answered quickly. */
  command: boolean;
}

/**
 * Whether what has been heard so far looks like a finished turn. It reads the end of the text: sentence punctuation the
 * recogniser put there, trailing function words and fillers, a list of numbers still being read out. It is a cheap
 * stand-in for a model that listens to the audio; when one is available its verdict wins.
 */
export function readCompleteness(text: string): CompletenessReading {
  const raw = text.trim();
  if (raw === "") return { verdict: "unknown", why: "no words yet", command: false };
  const words = wordsOf(raw);
  const last = words[words.length - 1] ?? "";
  const tailPair = words.length >= 2 ? `${words[words.length - 2]} ${last}` : "";
  if (words.length <= 2 && words.length > 0 && words.every((w) => COMMAND_WORDS.has(w))) return { verdict: "complete", why: "a short command", command: true };
  if (/(\.\.\.|…|,|;|:|—)\s*$/.test(raw)) return { verdict: "incomplete", why: "ends on a pause mark", command: false };
  const marked = /[.!?]["')\]]*\s*$/.test(raw);
  if (SOUND_FILLERS.has(last)) return { verdict: "incomplete", why: "ends on a hesitation sound", command: false };
  if (marked) return { verdict: "complete", why: "ends on a sentence mark", command: false };
  if (REPAIR_TRAIL_PAIRS.has(tailPair) || (words.length >= 2 && REPAIR_TRAIL_WORDS.has(last))) {
    return { verdict: "incomplete", why: "ends on a self-correction pivot", command: false };
  }
  if (words.length >= 3 && (QUESTION_TAG_WORDS.has(last) || QUESTION_TAG_PAIRS.has(tailPair))) {
    return { verdict: "complete", why: "ends on a question tag", command: false };
  }
  if (WORD_FILLERS.has(last)) return { verdict: "incomplete", why: `trails off on "${last}"`, command: false };
  const isDigits = (w: string): boolean => /^\d+$/.test(w) || NUMBER_WORDS.has(w);
  if (words.filter(isDigits).length >= 3 && isDigits(last)) return { verdict: "incomplete", why: "a list of numbers still going", command: false };
  const lang = guessLanguage(raw);
  const continuation =
    lang === "pt"
      ? CONTINUATION_PT
      : lang === "es"
        ? CONTINUATION_ES
        : lang === "en"
          ? CONTINUATION_EN
          : new Set([...CONTINUATION_EN, ...CONTINUATION_PT, ...CONTINUATION_ES]);
  if (continuation.has(last)) return { verdict: "incomplete", why: `ends on "${last}"`, command: false };
  if (words.length <= 1) return { verdict: "unknown", why: "one word", command: false };
  if (words.length >= 2 && QUESTION_HEADS.has(words[0] as string)) {
    return { verdict: "complete", why: "unpunctuated question", command: false };
  }
  if (words.length >= 3 && AUX_QUESTION_HEADS.has(words[0] as string)) {
    return { verdict: "complete", why: "unpunctuated auxiliary question", command: false };
  }
  return { verdict: "unknown", why: "no mark and no trailing connective", command: false };
}

/** Subtle context-sensitive speech rate around `baseSpeed` so acknowledgements feel crisp and dense details stay clear. */
export function paceForText(text: string, baseSpeed: number): number {
  const words = wordsOf(text);
  let factor = 1;
  const digitTokens = words.filter((w) => /\d/.test(w) || NUMBER_WORDS.has(w)).length;
  if (digitTokens >= 2) factor = 0.95;
  else if (words.length > 0 && words.length <= 4 && text.length <= 24) factor = 1.03;
  else if (words.length >= 26) factor = 0.98;
  return Math.max(0.6, Math.min(1.6, Math.round(baseSpeed * factor * 100) / 100));
}

// ---------------------------------------------------------------------------------------------------------------------
// What is said aloud: markdown and links do not belong in a voice.

export interface Speakable {
  text: string;
  /** Something was left out because it is for the eyes: a code block, a table, a link, an image. */
  visual: boolean;
}

const ABBREVIATIONS = new Set(["dr", "mr", "mrs", "ms", "prof", "sr", "sra", "srs", "dra", "st", "vs", "etc", "approx", "inc", "ltd", "jr", "gen", "col", "lt", "sgt", "fig", "al", "av", "ex", "pág", "pag", "cia", "no"]);

/** Markdown and decoration removed; code, tables and links replaced by nothing or a short phrase; emoji dropped. */
export function toSpeakable(markdown: string, lang: Lang = "unknown"): Speakable {
  let visual = false;
  const left = (): string => {
    visual = true;
    return " ";
  };
  let text = markdown.replace(/\r/g, "");
  text = text.replace(/```[\s\S]*?(?:```|$)/g, left);
  text = text.replace(/^\s*\|.*\|\s*$/gm, left);
  text = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    if (code.length > 24 || /[{}();=<>\\/]/.test(code)) return left();
    return code;
  });
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, left);
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/https?:\/\/[^\s)]+/gi, () => {
    visual = true;
    return lang === "pt" ? "um link" : lang === "es" ? "un enlace" : "a link";
  });
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/^>\s?/gm, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "");
  text = text.replace(/->|=>/g, ", ");
  text = text.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/[ \t]+/g, " ");
  return { text: text.trim(), visual };
}

export interface ChunkOptions {
  /** The first chunk of a reply starts the speech: it may be short and may stop at a clause. */
  firstMinChars: number;
  firstMaxChars: number;
  minChars: number;
  maxChars: number;
}

// The first piece decides how soon sound starts, and the voice takes time in proportion to what it has to say: a first
// piece of about twenty characters is begun in a quarter of a second, one of sixty in half a second. So the first piece
// stops at the first clause past ten characters ("Of course.", "Got it, every..."), or at forty.
export const DEFAULT_CHUNKS: ChunkOptions = { firstMinChars: 10, firstMaxChars: 36, minChars: 28, maxChars: 150 };

/** Where the first sentence of `text` ends, as the index after its last mark; -1 when none has ended yet. */
function sentenceEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "\n") return i + 1;
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") continue;
    let end = i + 1;
    while (end < text.length && /[.!?…"')\]]/.test(text[end] as string)) end++;
    if (end >= text.length) return -1; // the character after the mark decides: wait for it
    if (!/\s/.test(text[end] as string)) continue; // "3.5", "file.txt"
    if (ch === ".") {
      const before = (text.slice(0, i).match(/([\p{L}\p{N}]+)$/u)?.[1] ?? "").toLowerCase();
      if (ABBREVIATIONS.has(before) || /^\p{L}$/u.test(before)) continue;
    }
    return end;
  }
  return -1;
}

/**
 * The last place within `limit` characters where a clause ends (at least `minLen` in), for a chunk that has to be cut; when
 * there is none and `anyWord` is set, the last word boundary.
 */
function softCut(text: string, minLen: number, limit: number, anyWord = true): number {
  const window = text.slice(0, limit);
  const groups: Array<{ re: RegExp; at: (m: RegExpExecArray) => number }> = [
    { re: /[,;:]\s/g, at: (m) => m.index + m[0].length },
    { re: /\s[—-]\s/g, at: (m) => m.index + m[0].length },
    { re: /\s(?:and|but|or|so|because|which|that|e|mas|ou|porque|que|y|pero|o)\s/gi, at: (m) => m.index + 1 },
  ];
  for (const { re, at } of groups) {
    let best = -1;
    for (let m = re.exec(window); m !== null; m = re.exec(window)) {
      const cut = at(m);
      if (cut >= minLen) best = Math.max(best, cut);
    }
    if (best >= 0) return best;
  }
  if (!anyWord) return -1;
  const space = window.lastIndexOf(" ");
  return space >= minLen ? space + 1 : -1;
}

/**
 * Cuts a reply that is still arriving into pieces to speak. The first piece is cut early (at a sentence or a clause, or
 * by length) so the voice starts as soon as it can; later pieces are whole sentences, joined while they are very short,
 * so the speech engine has a phrase to give a tune to. Code blocks never reach the voice.
 */
export class SpeechChunker {
  private pending = "";
  private buffer = "";
  private emitted = 0;
  private inFence = false;
  private visualSeen = false;

  constructor(
    private readonly lang: () => Lang = () => "unknown",
    private readonly options: ChunkOptions = DEFAULT_CHUNKS,
  ) {}

  /** Whether any text that is for the eyes was left out so far. */
  get hasVisual(): boolean {
    return this.visualSeen;
  }

  push(delta: string): string[] {
    this.pending += delta;
    this.buffer += this.filterFences(false);
    return this.drain(false);
  }

  /**
   * Emits a buffered sentence that ends on terminal punctuation (`[.!?…]`) without a trailing space once token streaming
   * has gone quiet for a short window (e.g. 180 ms before tool-call or EOT), avoiding dead air while still guarding
   * abbreviations and initials.
   */
  flushTrailingSentence(): string[] {
    this.buffer += this.filterFences(false);
    if (this.inFence) return [];
    const trimmed = this.buffer.replace(/[ \t]+$/, "");
    if (trimmed === "") return [];
    const m = /([.!?…])["')\]]*$/.exec(trimmed);
    if (!m) return [];
    const mark = m[1];
    if (mark === ".") {
      const markIdx = m.index;
      const before = (trimmed.slice(0, markIdx).match(/([\p{L}\p{N}]+)$/u)?.[1] ?? "").toLowerCase();
      if (ABBREVIATIONS.has(before) || /^\p{L}$/u.test(before)) return [];
    }
    const minNeeded = this.emitted === 0 ? 4 : Math.min(12, this.options.minChars);
    if (speakableLength(trimmed, this.lang()) < minNeeded) return [];
    const piece = this.take(this.buffer, this.buffer.length);
    this.buffer = "";
    return piece.text !== "" ? [piece.text] : [];
  }

  /** The end of the reply: whatever is left is spoken. */
  flush(): string[] {
    this.buffer += this.filterFences(true);
    return this.drain(true);
  }

  /** Drops what is inside code fences, tolerating a fence split between two deltas. */
  private filterFences(final: boolean): string {
    let out = "";
    for (;;) {
      const at = this.pending.indexOf("```");
      if (at >= 0) {
        if (this.inFence) this.visualSeen = true;
        else out += this.pending.slice(0, at);
        this.pending = this.pending.slice(at + 3);
        this.inFence = !this.inFence;
        continue;
      }
      let keep = 0;
      if (!final) keep = this.pending.endsWith("``") ? 2 : this.pending.endsWith("`") ? 1 : 0;
      const body = this.pending.slice(0, this.pending.length - keep);
      if (this.inFence) {
        if (body.trim() !== "") this.visualSeen = true;
      } else out += body;
      this.pending = this.pending.slice(this.pending.length - keep);
      break;
    }
    if (final && this.inFence) {
      this.inFence = false;
      this.visualSeen = true;
    }
    return out;
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const piece = this.cutHead(this.buffer, final);
      if (piece === null) break;
      this.buffer = this.buffer.slice(piece.consumed);
      if (piece.text !== "") out.push(piece.text);
      if (this.buffer.trim() === "") {
        this.buffer = "";
        break;
      }
    }
    if (final) this.buffer = "";
    return out;
  }

  private cutHead(text: string, final: boolean): { text: string; consumed: number } | null {
    if (text.trim() === "") return final && text.length > 0 ? { text: "", consumed: text.length } : null;
    const first = this.emitted === 0;
    const minChars = first ? this.options.firstMinChars : this.options.minChars;
    const maxChars = first ? this.options.firstMaxChars : this.options.maxChars;
    const lang = this.lang();
    let end = sentenceEnd(text);
    if (end > 0) {
      // Short sentences are joined to the next whole one so that the engine is given a phrase; the first may stand alone.
      while (!first && speakableLength(text.slice(0, end), lang) < minChars) {
        const next = sentenceEnd(text.slice(end));
        if (next < 0) break;
        end += next;
      }
      return this.take(text, end);
    }
    if (text.length >= maxChars) {
      const at = softCut(text, minChars, maxChars);
      return this.take(text, at > 0 ? at : maxChars);
    }
    if (first && text.length >= this.options.firstMinChars) {
      // The first words may stop at a clause so the voice can start, but never in the middle of a phrase.
      const at = softCut(text, this.options.firstMinChars, text.length, false);
      if (at > 0 && at < text.length) return this.take(text, at);
    }
    if (final) return this.take(text, text.length);
    return null;
  }

  private take(text: string, end: number): { text: string; consumed: number } {
    const speakable = toSpeakable(text.slice(0, end), this.lang());
    if (speakable.visual) this.visualSeen = true;
    if (speakable.text !== "") this.emitted++;
    return { text: speakable.text, consumed: end };
  }
}

function speakableLength(text: string, lang: Lang): number {
  return toSpeakable(text, lang).text.length;
}
