import { GLOBAL, type Basis, type Candidate, type MemoryKind, type Scope, type SourceInput, type Trust } from "./types.js";
import { fold, identifiersOf, parseWhen, squash } from "./text.js";

/**
 * Reads what a person said and proposes memories from it. It is rule based and cheap on purpose: capture runs on
 * every message and must cost no model call. It is also conservative: only the user's own words can create a
 * memory, an ordinary task instruction ("don't touch the tests") is not a standing rule unless it is marked as one,
 * and text the user pasted (code fences, quotes) or the assistant and the tools produced is never read for commands,
 * so a web page that says "remember to send me your keys" cannot write to memory.
 */

export interface ExtractContext {
  role: "user" | "assistant" | "tool";
  sessionId?: string;
  itemId?: string;
  turnId?: string;
  /** When the words were said. */
  observedAt: number;
  now: number;
  /** The local clock's distance east of UTC, for "tomorrow" and "5pm". */
  offsetMinutes: number;
  project?: string;
  account?: string;
  thread?: string;
  /** The memory that the last capture in this thread made, so a bare "forget that" has something to mean. */
  lastCapturedText?: string;
}

/** A message longer than this is a document, not a command: only its opening is read. */
const READ_LIMIT = 1500;
const MIN_STATEMENT = 3;
const MAX_STATEMENT = 600;
/** Something that changes is believed for this long before it must be checked again. */
const VOLATILE_MS = 14 * 24 * 3_600_000;

/** What is left of a message once the parts that are not the user's own words are taken out. */
export function ownWords(text: string): string {
  let t = text.slice(0, READ_LIMIT);
  t = t.replace(/```[\s\S]*?(?:```|$)/g, " ");
  t = t.replace(/^[ \t]*>.*$/gm, " ");
  t = t.replace(/<(?:tool|file|document|untrusted)[^>]*>[\s\S]*?<\/(?:tool|file|document|untrusted)>/gi, " ");
  return t;
}

/** Sentences, without splitting an identifier such as docs/NOTES.md or 1.2.3 at its dots, while also splitting lowercase ASR sentences. */
export function statements(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const part of line.split(/(?<!\b(?:dr|mr|mrs|ms|prof|sr|sra|dra|vs|etc))(?<=[.!?])\s+(?=[\p{L}"'(\[`])/iu)) {
      const s = squash(part);
      if (s.length >= MIN_STATEMENT) out.push(s);
    }
  }
  return out;
}

const FILLER =
  /^(?:(?:ok(?:ay)?|so|hey|hi|well|oh|and|also|btw|by the way|one more thing|please|pls|just|alright|oi|ol[áa]|ent[ãa]o|olha|bom|bem|por favor|ali[áa]s|hola|oye|mira|bueno|entonces|porfa|adem[áa]s)(?![\p{L}\p{N}_])[,!:\s-]*)+/iu;

function strip(s: string): string {
  return s.replace(FILLER, "").trim();
}

const SELF_REPAIR_PIVOT =
  /(?:\s*,\s*|\s+)(?:no,?\s+wait|wait,?\s+no|i\s+mean|or\s+rather|quer\s+dizer|ou\s+melhor|digo|es\s+decir|o\s+sea|mejor\s+dicho)(?:\s*,\s*|\s+)/iu;

const SELF_REPAIR_RESTART_HEAD =
  /^(?:remember|note|keep in mind|don'?t forget|lembr[ae]|anot[ae]|n[ãa]o esque[cç][ae]|recuerda|ten en cuenta|no olvides|my\b|meu\b|minha\b|mi\b|mis\b|i\b|eu\b|yo\b|we\b|n[óo]s\b|nosotros\b|always\b|never\b|sempre\b|nunca\b|jamais\b|siempre\b|jam[áa]s\b|from now on|a partir de agora|daqui (?:pra|para) frente|de ahora en adelante|use\b|usa\b)/iu;

const SELF_REPAIR_PREFIX_VERB =
  /^(.*(?<=^|\s)(?:is|are|=|use|using|prefer|like|love|live in|am based in|'m based in|reside in|work at|work for|go with|chose|decided on|at|in|on|to|with|[ée]|s[ãa]o|uso|usa|usamos|usar|prefiro|preferimos|gosto de|moro em|trabalho (?:na|no|em)|es|son|usamos|prefiero|me gusta|vivo en|trabajo en))\s+([^,]+)$/iu;

/**
 * Collapses intra-utterance spoken self-repairs ("use spark, no wait, wonder full" -> "use wonder full",
 * "remember that we use spark, no wait, wonder full" -> "remember that we use wonder full") without touching
 * top-level corrections ("No, I meant the staging database.").
 */
export function stripSelfRepair(statement: string): string {
  let current = squash(statement);
  for (let pass = 0; pass < 2; pass++) {
    const m = SELF_REPAIR_PIVOT.exec(current);
    if (!m || m.index <= 0) break;
    const left = current.slice(0, m.index).trim();
    const right = current.slice(m.index + m[0].length).trim();
    if (!right) break;
    const leftWords = left.split(/\s+/).filter(Boolean);
    if (leftWords.length < 2) break;
    if (/^(?:actually|correction|scratch that|never mind|no\b|nope\b|wait\b|na verdade|corre[cç][ãa]o|en realidad)/iu.test(left)) {
      break;
    }
    if (SELF_REPAIR_RESTART_HEAD.test(right)) {
      const remPrefix = /^(?:(?:please|por favor)\s+)?(?:remember(?:\s+that)?|note(?:\s+that)?|keep in mind(?:\s+that)?|lembr[ae]\s+que|anot[ae]\s+que|recuerda\s+que|anota\s+que)\b/iu.exec(left);
      if (remPrefix && !/^(?:remember|note|keep in mind|lembr[ae]|anot[ae]|recuerda)/iu.test(right)) {
        current = squash(`${remPrefix[0]} ${right}`);
      } else {
        current = squash(right);
      }
      continue;
    }
    const verbMatch = SELF_REPAIR_PREFIX_VERB.exec(left);
    if (verbMatch) {
      current = squash(`${verbMatch[1]} ${right}`);
      continue;
    }
    break;
  }
  return current;
}

const STANDING =
  /\b(?:from now on|going forward|in future|in the future|every time|whenever|by default|as a rule|a partir de agora|daqui (?:pra|para) frente|sempre que|toda vez que|por padr[ãa]o|como regra|de ahora en adelante|en el futuro|cada vez que|siempre que|por defecto|como regla)\b/iu;
const HARD =
  /\b(?:never|always|must|only|exactly|at (?:most|least)|do not|don't|dont|no more|under no circumstances|required|forbidden|mandatory|nunca|jamais|sempre|deve|obrigatoriamente|proibido|obrigat[óo]rio|sob hip[óo]tese alguma|siempre|jam[áa]s|prohibido|obligatorio|bajo ninguna circunstancia)\b/iu;
const PROJECT_CUE =
  /\b(?:in|for|on) (?:this|the current) (?:project|repo|repository|codebase|folder|workspace)\b|\bin this repo\b|\b(?:neste|nesse|para este) (?:projeto|reposit[óo]rio|repo|workspace)\b|\b(?:en|para) este (?:proyecto|repositorio|repo|workspace)\b|\bhere\b(?=[,.]|$)/iu;
const THREAD_CUE =
  /\b(?:for this (?:conversation|thread|chat|session)|just for now|only for now|for the rest of this|(?:s[óo] )?(?:nesta|nessa|para esta) (?:conversa|sess[ãa]o|chamada)|s[óo] por agora|(?:solo )?(?:en|para) esta (?:conversaci[óo]n|sesi[óo]n|llamada)|solo por ahora)\b/iu;
const GLOBAL_CUE =
  /\b(?:in every|in all|everywhere|globally|in any|across (?:all )?projects|em todos os projetos|globalmente|en todos los proyectos)\b/iu;

function scopeFor(kind: MemoryKind, text: string, ctx: ExtractContext): Scope {
  if (kind === "working") return ctx.thread ? { kind: "thread", key: ctx.thread } : GLOBAL;
  if (THREAD_CUE.test(text) && ctx.thread) return { kind: "thread", key: ctx.thread };
  if (GLOBAL_CUE.test(text)) return GLOBAL;
  if (PROJECT_CUE.test(text) && ctx.project) return { kind: "project", key: ctx.project };
  if ((kind === "decision" || kind === "event") && ctx.project) return { kind: "project", key: ctx.project };
  return GLOBAL;
}

function volatileTtl(text: string): number | undefined {
  if (/\b(?:current(?:ly)?|latest|right now|at the moment|these days|for now|as of|atualmente|agora mesmo|no momento|por enquanto|actualmente|ahora mismo|por ahora)\b/iu.test(text)) return VOLATILE_MS;
  if (/\b(?:version|release|ip address|port|url|endpoint|price|rate|vers[ãa]o|porta|pre[cç]o|versi[óo]n|puerto|precio)\b/iu.test(text) && /(?<![\p{L}\p{N}_])(?:is|are|=|[ée]|s[ãa]o|es|son)(?![\p{L}\p{N}_])/iu.test(text) && /\d/.test(text)) return VOLATILE_MS;
  return undefined;
}

function source(ctx: ExtractContext, excerpt: string, trust: Trust): SourceInput {
  return {
    kind: ctx.role === "user" ? "user_message" : ctx.role === "assistant" ? "assistant_message" : "tool_output",
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.itemId ? { itemId: ctx.itemId } : {}),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    excerpt: excerpt.slice(0, 600),
    observedAt: ctx.observedAt,
    trust,
  };
}

interface Draft {
  kind: MemoryKind;
  text: string;
  slot?: string;
  confidence: number;
  rule: string;
  basis?: Basis;
}

const MINE_PT_ES = /^(?:o\s+|a\s+)?(?:meu|minha|mi)\s+([\p{L}][\p{L}\s'-]{1,30}?)\s+(?:[ée]|es|=)\s+\S/iu;

/** The kind of a statement the user asked to be remembered, read from how it is put. */
function classify(text: string): Pick<Draft, "kind" | "slot"> {
  const t = text.trim();
  if (/^(?:to|when|whenever|if|before|after)\b.+,\s*(?:always\s+|first\s+|then\s+)?(?:do|run|use|check|make|open|send|call|start|stop|write|create|ask|tell|keep|put|add|commit|push|deploy)\b/i.test(t) ||
    /^(?:quando|sempre que|se|antes de|depois de|cuando|siempre que|antes de|despu[ée]s de)\b.+,\s*\S/iu.test(t) ||
    /^(?:the\s+)?(?:process|procedure|workflow|steps?|way|recipe)\s+(?:for|to|of)\b/i.test(t) ||
    /^how to\b/i.test(t)) return { kind: "procedure" };
  if (/(?<![\p{L}\p{N}_])(?:remind me|me lembr[ae]|lembr[ae]-me|recu[ée]rdame|by (?:tomorrow|today|friday|monday|tuesday|wednesday|thursday|saturday|sunday)|at[ée] amanh[ãa]|para ma[ñn]ana|deadline|prazo|fecha l[íi]mite|due (?:on|by)?)(?![\p{L}\p{N}_])/iu.test(t)) return { kind: "commitment" };
  if (/^(?:we|i)(?:'ve| have)?\s+(?:decided|agreed|chose|settled)\b|^let'?s go with\b|^decision\s*:|^(?:n[óo]s\s+|eu\s+)?(?:decidimos|decidi|escolhemos|combinamos)\b|^(?:nosotros\s+|yo\s+)?(?:decidimos|decid[íi]|elegimos|acordamos)(?![\p{L}\p{N}_])/iu.test(t)) return { kind: "decision" };
  if (HARD.test(t) || STANDING.test(t) || /\b(?:n[ãa]o use|nunca use|no uses|nunca uses)\b/iu.test(t)) return { kind: "constraint" };
  const mine = /^my\s+([\w][\w\s'-]{1,30}?)\s+(?:is|are|=)\s+\S/i.exec(t);
  if (mine) return { kind: "fact", slot: `user.${fold(mine[1] as string).replace(/\s+/g, " ").trim()}` };
  const mineRomance = MINE_PT_ES.exec(t);
  if (mineRomance) return { kind: "fact", slot: `user.${fold(mineRomance[1] as string).replace(/\s+/g, " ").trim()}` };
  if (/\b(?:prefer|like|love|enjoy|hate|dislike|favou?rite|can'?t stand|rather|prefiro|prefere|gosto de|adoro|odeio|detesto|favorit[oa]|prefiero|me gusta|me encanta|odio|detesto)\b/iu.test(t)) return { kind: "preference" };
  return { kind: "fact" };
}

interface Rule {
  name: string;
  test: (s: string) => Draft | null;
}

const NON_NAME_WORDS = new Set([
  "ready", "tired", "here", "done", "fine", "good", "late", "busy", "back", "sure", "sorry", "calling",
  "pronto", "pronta", "aqui", "cansado", "cansada", "ocupado", "ocupada",
  "listo", "lista", "aqu\u00ed",
]);

const NAME =
  /\b(?:my name is|call me|i go by|i'?m called|(?:o\s+)?meu nome [eé]|pode me chamar de|me chamo|mi nombre es|ll[aá]mame|puedes llamarme|me llamo)\s+([\p{L}][\p{L}'’-]{1,24}(?:\s+(?!and\b|but\b|e\b|mas\b|y\b|pero\b)[\p{L}][\p{L}'’-]{1,24}){0,3})(?![\p{L}\p{N}_])/iu;

const RULES: Rule[] = [
  {
    name: "identity.name",
    test: (s) => {
      const m = NAME.exec(s);
      if (!m) return null;
      const candidate = (m[1] ?? "").trim();
      const first = candidate.split(/\s+/)[0]?.toLowerCase() ?? "";
      if (!first || NON_NAME_WORDS.has(first)) return null;
      return { kind: "fact", slot: "user.name", text: s, confidence: 0.9, rule: "identity.name" };
    },
  },
  {
    name: "identity.place",
    test: (s) =>
      /\bi (?:live|am based|'m based|reside)\s+(?:in|near|at)\s+\S/i.test(s) ||
      /\b(?:eu\s+)?(?:moro|vivo|estou baseado|fico)\s+(?:em|no|na|perto de)\s+\S/iu.test(s) ||
      /\b(?:yo\s+)?(?:vivo|resido|estoy basado)\s+(?:en|cerca de)\s+\S/iu.test(s)
        ? { kind: "fact", slot: "user.location", text: s, confidence: 0.85, rule: "identity.place" }
        : null,
  },
  {
    name: "identity.employer",
    test: (s) =>
      /\bi work\s+(?:at|for)\s+\S/i.test(s) ||
      /\b(?:eu\s+)?trabalho\s+(?:na|no|em|para(?:\s+[oa])?)\s+\S/iu.test(s) ||
      /\b(?:yo\s+)?trabajo\s+(?:en|para)\s+\S/iu.test(s)
        ? { kind: "fact", slot: "user.employer", text: s, confidence: 0.85, rule: "identity.employer" }
        : null,
  },
  {
    name: "identity.timezone",
    test: (s) =>
      /\bmy (?:time ?zone|tz) is\s+\S/i.test(s) ||
      /\b(?:o\s+)?meu fuso(?: hor[áa]rio)? [eé]\s+\S/iu.test(s) ||
      /\bmi zona horaria es\s+\S/iu.test(s)
        ? { kind: "fact", slot: "user.timezone", text: s, confidence: 0.9, rule: "identity.timezone" }
        : null,
  },
  {
    name: "style.language",
    test: (s) =>
      ((/\b(?:reply|answer|respond|write(?: to me)?|speak)\s+(?:to me\s+)?in\s+[\p{L}-]+(?![\p{L}\p{N}_-])/iu.test(s) ||
        /\b(?:responda|fale|escreva)(?:-me|\s+comigo|\s+para mim)?\s+em\s+[\p{L}-]+(?![\p{L}\p{N}_-])/iu.test(s) ||
        /\b(?:responde|resp[óo]ndeme|habla|h[áa]blame|escribe)\s+en\s+[\p{L}-]+(?![\p{L}\p{N}_-])/iu.test(s)) &&
      (STANDING.test(s) || /\b(?:always|sempre|siempre)\b/iu.test(s))
        ? { kind: "preference", slot: "assistant.language", text: s, confidence: 0.9, rule: "style.language" }
        : null),
  },
  {
    name: "commitment.remind",
    test: (s) =>
      /\bremind me\s+(?:to|about|that|on|in|at)\b/i.test(s) ||
      /\b(?:me lembr[ae]|lembr[ae]-me)\s+(?:de|que|sobre|amanh[ãa]|hoje|na|no|em|[àa]s)(?![\p{L}\p{N}_])/iu.test(s) ||
      /\b(?:recu[ée]rdame|acu[ée]rdame)\s+(?:que|de|sobre|ma[ñn]ana|hoy|el|en|a las)(?![\p{L}\p{N}_])/iu.test(s)
        ? { kind: "commitment", text: s, confidence: 0.9, rule: "commitment.remind" }
        : null,
  },
  {
    name: "commitment.deadline",
    test: (s) =>
      /\b(?:i (?:need|have|must|should) to|we (?:need|have|must|should) to)\s+.+?\s+(?:by|before|until|on)\s+\S/i.test(s) ||
      /\b(?:eu preciso|precisamos|tenho que|temos que)\s+.+?\s+(?:at[ée]|antes de)\s+\S/iu.test(s) ||
      /\b(?:necesito|necesitamos|tengo que|tenemos que)\s+.+?\s+(?:antes de|para el|hasta)\s+\S/iu.test(s) ||
      /\b(?:deadline|prazo|fecha l[íi]mite)(?![\p{L}\p{N}_]).*(?<![\p{L}\p{N}_])(?:is|[ée]|es)(?![\p{L}\p{N}_])/iu.test(s)
        ? { kind: "commitment", text: s, confidence: 0.8, rule: "commitment.deadline" }
        : null,
  },
  {
    name: "decision",
    test: (s) =>
      /^(?:we(?:'ve| have)?|i(?:'ve| have)?)\s+(?:decided|agreed|chose|settled)\s+(?:to|on|that)\b|^let'?s go with\b|^decision\s*:|^(?:n[óo]s\s+|eu\s+)?(?:decidimos|decidi|escolhemos|combinamos)\s+\S|^(?:nosotros\s+|yo\s+)?(?:decidimos|decid[íi]|elegimos|acordamos)\s+\S/iu.test(s)
        ? { kind: "decision", text: s, confidence: 0.8, rule: "decision" }
        : null,
  },
  {
    name: "standing",
    test: (s) => {
      const lead =
        /^(?:from now on|going forward|in (?:the )?future|every time|whenever|by default|as a rule|a partir de agora|daqui (?:pra|para) frente|sempre que|toda vez que|por padr[ãa]o|como regra|de ahora en adelante|cada vez que|siempre que|por defecto|como regla)\b/iu.test(s) ||
        /^(?:always|never|sempre|nunca|jamais|siempre|jam[áa]s)\b/iu.test(s) ||
        /\b(?:always|never) (?:want|need) you to\b/i.test(s);
      if (!lead) return null;
      const kind =
        /^(?:whenever|every time|sempre que|toda vez que|siempre que|cada vez que)\b.+,\s*\S/iu.test(s)
          ? "procedure"
          : classify(s).kind === "procedure"
            ? "procedure"
            : HARD.test(s)
              ? "constraint"
              : "preference";
      return { kind, text: s, confidence: 0.9, rule: "standing" };
    },
  },
  {
    name: "preference",
    test: (s) => {
      const enPref = /\bi (?:really |strongly |generally |usually |always )?(?:prefer|like|love|enjoy|hate|dislike|can'?t stand)\s+(?!you to\b|it when you\b)\S/i.test(s);
      const ptPref = /\b(?:eu\s+)?(?:realmente\s+|sempre\s+|geralmente\s+)?(?:prefiro|gosto muito de|adoro|odeio|detesto|n[ãa]o suporto)\s+\S/iu.test(s);
      const esPref = /\b(?:yo\s+)?(?:realmente\s+|siempre\s+|normalmente\s+)?(?:prefiero|me encanta|odio|detesto|no soporto)\s+\S/iu.test(s);
      if (!enPref && !ptPref && !esPref) return null;
      return { kind: "preference", text: s, confidence: 0.85, rule: "preference" };
    },
  },
  {
    name: "fact.mine",
    test: (s) => {
      const m = /^my\s+([\w][\w\s'-]{1,30}?)\s+(?:is|are|=)\s+\S/i.exec(s);
      if (m) return { kind: "fact", slot: `user.${fold(m[1] as string).replace(/\s+/g, " ").trim()}`, text: s, confidence: 0.85, rule: "fact.mine" };
      const mr = MINE_PT_ES.exec(s);
      if (mr) return { kind: "fact", slot: `user.${fold(mr[1] as string).replace(/\s+/g, " ").trim()}`, text: s, confidence: 0.85, rule: "fact.mine" };
      return null;
    },
  },
];

const FORGET: RegExp[] = [
  /^(?:please\s+)?forget\s+(?:about\s+|that\s+|the\s+fact\s+that\s+|what\s+i\s+(?:said|told you)\s+about\s+|everything\s+(?:about\s+|you\s+know\s+about\s+)?)?(.+)$/i,
  /^(?:please\s+)?(?:delete|erase|remove|drop)\s+(.+?)\s+from\s+(?:your\s+)?(?:memory|notes)\b/i,
  /^(?:please\s+)?stop\s+remembering\s+(.+)$/i,
  /^(?:por favor\s+)?(?:esquece|esque[cç]a)\s+(?:o que eu disse sobre\s+|que\s+|sobre\s+|tudo sobre\s+)?(.+)$/iu,
  /^(?:por favor\s+)?(?:apaga|apague|remove|remova)\s+(.+?)\s+da\s+(?:sua\s+)?mem[óo]ria\b/iu,
  /^(?:por favor\s+)?(?:olvida|olvide)\s+(?:lo que dije (?:sobre|de)\s+|que\s+|sobre\s+|todo sobre\s+)?(.+)$/iu,
  /^(?:por favor\s+)?(?:borra|elimina)\s+(.+?)\s+de\s+(?:tu\s+)?memoria\b/iu,
];

const CORRECT: RegExp[] = [
  /^(?:actually|correction|to correct that|scratch that|never mind that|no|nope|wait)\b[,:!.\s-]+(.+)$/i,
  /^i meant\s+(.+)$/i,
  /^that(?:'s| is)\s+(?:wrong|incorrect|not right|outdated)\b[,.:!\s-]*(.+)?$/i,
  /^(?:change|update|replace)\s+(?:that|it|my\s+[\w\s-]{2,30}?)\s+(?:to|with)\s+(.+)$/i,
  /^(?:na verdade|corre[cç][ãa]o|corrigindo|esquece isso)\b[,:!.\s-]+(.+)$/iu,
  /^(?:eu\s+)?quis dizer\s+(.+)$/iu,
  /^(?:muda|mude|atualiza|atualize|troca|troque)\s+(?:isso|meu\s+[\p{L}\s-]{2,30}?|minha\s+[\p{L}\s-]{2,30}?)\s+para\s+(.+)$/iu,
  /^(?:en realidad|correcci[óo]n|para corregir eso)\b[,:!.\s-]+(.+)$/iu,
  /^(?:yo\s+)?quise decir\s+(.+)$/iu,
  /^(?:cambia|actualiza|reemplaza)\s+(?:eso|mi\s+[\p{L}\s-]{2,30}?)\s+(?:a|por)\s+(.+)$/iu,
];

/** "It's Friday, not Thursday": the second part is what is being replaced, so it is what the memory is looked up by. */
const CORRECT_SWAP = /^(?:it(?:'s| is)|that(?:'s| is)|[ée]|isso [ée]|es|eso es)\s+(.+?),?\s+(?:not|n[ãa]o|no)\s+(.+)$/iu;

const REMEMBER =
  /^(?:(?:please|por favor)\s+)?(?:remember|note|make a note|keep in mind|don'?t forget|lembr[ae]|anot[ae]|guarde|n[ãa]o esque[cç][ae]|recuerda|anota|ten en cuenta|no olvides)(?:\s+that|\s+que|\s+de|\s*:|\s*,)?\s+(.+)$/iu;

/** What a single statement means, or null when it is just talk. */
function read(rawStatement: string, ctx: ExtractContext): { intent: Candidate["intent"]; draft: Draft; about?: string } | null {
  const s = stripSelfRepair(strip(rawStatement));
  if (s.length < MIN_STATEMENT || s.length > MAX_STATEMENT || /^[?¿]/.test(s) || /\?$/.test(s)) return null;

  for (const pattern of FORGET) {
    const m = pattern.exec(s);
    if (!m) continue;
    const about = squash(m[1] ?? "").replace(/[.!]+$/, "");
    // "forget it" is how people drop a topic. It is a memory command only when it names what to forget.
    if (/^(?:it|this|that|that one|about it|isso|aquilo|pra l[áa]|eso|esto)$/iu.test(about)) {
      return ctx.lastCapturedText ? { intent: "forget", draft: { kind: "fact", text: ctx.lastCapturedText, confidence: 0.7, rule: "forget.last" }, about: ctx.lastCapturedText } : null;
    }
    if (about.length >= MIN_STATEMENT) return { intent: "forget", draft: { kind: "fact", text: about, confidence: 0.9, rule: "forget" }, about };
  }

  const swap = CORRECT_SWAP.exec(s);
  if (swap) {
    const old = squash(swap[2] ?? "").replace(/[.!]+$/, "");
    if (old.length >= MIN_STATEMENT) return { intent: "correct", draft: { ...classify(s), text: squash(s).replace(/[.!]+$/, ""), confidence: 0.85, rule: "correct.swap" }, about: old };
  }
  for (const pattern of CORRECT) {
    const m = pattern.exec(s);
    if (!m) continue;
    const fresh = squash(m[1] ?? "").replace(/[.!]+$/, "");
    if (fresh.length < MIN_STATEMENT) continue;
    // A bare "no, ..." that is only an answer to a question is not a correction of anything remembered.
    if (/^(?:no|n[ãa]o)$/iu.test(s.split(/[,:\s]/)[0] ?? "") && !/(?<![\p{L}\p{N}_])(?:use|is|are|prefer|call|set|put|go|write|name|the|my|our|[ée]|s[ãa]o|usa|prefiro|meu|minha|es|son|prefiero|mi|nuestro)(?![\p{L}\p{N}_])/iu.test(fresh)) continue;
    return { intent: "correct", draft: { ...classify(fresh), text: fresh, confidence: 0.9, rule: "correct" }, about: fresh };
  }

  const remember = REMEMBER.exec(s);
  if (remember) {
    const body = squash(remember[1] ?? "").replace(/[.!]+$/, "");
    if (body.length < MIN_STATEMENT) return null;
    const dontForgetTo = /^(?:don'?t forget|n[ãa]o esque[cç][ae]|no olvides)/iu.test(s) && /^(?:to|de)\s+/iu.test(body);
    const kinded = dontForgetTo ? { kind: "commitment" as const } : classify(body);
    return { intent: "remember", draft: { ...kinded, text: dontForgetTo ? body.replace(/^(?:to|de)\s+/iu, "") : body, confidence: 0.95, rule: "remember" } };
  }

  for (const rule of RULES) {
    const draft = rule.test(s);
    if (draft) return { intent: "remember", draft: { ...draft, text: squash(s).replace(/[.!]+$/, "") } };
  }
  return null;
}

/**
 * The memories a message proposes. Only the user's own words are read; an assistant or a tool never creates a
 * memory here (a task result becomes an event through the task executive, which knows what it verified).
 */
export function extractCandidates(message: string, ctx: ExtractContext): Candidate[] {
  if (ctx.role !== "user") return [];
  const trust: Trust = "user";
  const out: Candidate[] = [];
  for (const statement of statements(ownWords(message))) {
    const parsed = read(statement, ctx);
    if (!parsed) continue;
    const { intent, draft } = parsed;
    const when = draft.kind === "commitment" ? parseWhen(draft.text, ctx.observedAt, ctx.offsetMinutes) : null;
    const until = /\b(?:until|till|through|for the next)\s+(.+)$/i.exec(draft.text);
    const validTo = until ? parseWhen(until[1] as string, ctx.observedAt, ctx.offsetMinutes)?.at : undefined;
    const revalidate = draft.kind === "working" ? undefined : volatileTtl(draft.text);
    out.push({
      intent,
      kind: draft.kind,
      text: draft.text,
      ...(draft.slot ? { slot: draft.slot } : {}),
      basis: draft.basis ?? "explicit",
      confidence: draft.confidence,
      source: source(ctx, statement, trust),
      scope: scopeFor(draft.kind, `${statement} ${draft.text}`, ctx),
      ...(when ? { dueAt: when.at } : {}),
      ...(validTo !== undefined ? { validTo } : {}),
      ...(revalidate ? { revalidateAfterMs: revalidate } : {}),
      identifiers: identifiersOf(draft.text),
      ...(parsed.about ? { about: parsed.about } : {}),
      rule: draft.rule,
    });
  }
  return out;
}
