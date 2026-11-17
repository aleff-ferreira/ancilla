/**
 * A small router with no model in it, for the few spoken requests that a model of a few billion parameters does not pick a tool
 * for reliably. Measured on 2026-11-17 with two 4B models on an RTX 5070: a Portuguese "what is the status of the tasks" never
 * reached `list_tasks`, and "remind me what the Liverpool project is about" never reached `recall`, with seven tools as well as
 * with nineteen. They are recognised here, in English, Portuguese and Spanish, and the tool is run before the model answers.
 *
 * Pure: the words in, a decision out. Nothing here changes anything. A request to cancel is only recognised (the call asks
 * "cancel it?" before anything is done, see talker.ts); the rest is reading.
 */

export type Route =
  | { kind: "none" }
  /** Run this tool now, and give the model what it says. */
  | { kind: "run"; tool: "list_tasks" | "task_status" | "recall"; args: Record<string, string> }
  /** The person asks to cancel a task: `ref` is what they called it, or "last". */
  | { kind: "cancel"; ref: string }
  /** The person answers the question that was asked before a cancellation. */
  | { kind: "answer"; yes: boolean };

/** Longer requests are not routed: they are more than one thing, and the model is better placed to tell which. */
const MAX_WORDS = 25;

/** Lower case, no accents, no punctuation: what ASR writes and what a keyboard writes read the same. */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NOISE = new Set(
  (
    "the that this those these my our a an please now just it one of on for about with me to and task tasks job jobs proposal proposals request requests change changes last latest current running active " +
    "o os as um uma essa esse esta este aquela aquele isso aquilo minha meu dessa desse da do de das dos na no em por favor agora tarefa tarefas trabalho trabalhos proposta propostas pedido pedidos mudanca alteracao " +
    "el la los las un una esa ese eso esto mi mis del al ahora tarea tareas trabajo propuesta propuestas solicitud cambio ultima ultimo actual"
  ).split(" "),
);

/** The words of a name without the filler at either end ("the auth refactor task" is "auth refactor"); the words inside it are kept. */
function trimNoise(text: string): string {
  const words = text.split(" ").filter((w) => w !== "");
  let from = 0;
  let to = words.length;
  while (from < to && NOISE.has(words[from] as string)) from += 1;
  while (to > from && NOISE.has(words[to - 1] as string)) to -= 1;
  return words.slice(from, to).join(" ");
}

/** What the person called a task; "last" when they called it nothing ("that task"). */
function refOf(rest: string): string {
  return trimNoise(rest) || "last";
}

const TASK_NOUN = /\b(?:tasks?|jobs?|proposals?|requests?|changes?|tarefas?|trabalhos?|propostas?|pedidos?|mudancas?|alteracoes?|tareas?|trabajos?|propuestas?|solicitud(?:es)?|cambios?)\b/;
const PLURAL_TASKS = /\b(?:tasks|jobs|proposals|tarefas|trabalhos|propostas|tareas|trabajos|propuestas)\b/;

// ---------------------------------------------------------------------------------------------------------------------
// Cancelling: the request, and the answer to the question that follows it.

const LEAD_IN =
  "(?:(?:please|ok|okay|hey|well|so|then|now|just|can you|could you|would you|will you|go ahead and|i want you to|i need you to|por favor|pode|poderia|voce pode|voce poderia|vc pode|entao|ai|olha|quero que voce|preciso que voce|puedes|podrias|quiero que|necesito que|entonces|oye)\\s+)*";
const CANCEL = new RegExp(
  `^${LEAD_IN}(?:cancel|stop|abort|kill|scrap|cancela|cancele|cancelar|pare|parar|aborta|aborte|abortar|interrompe|interrompa|interromper|detener|deten|detente)\\s+(.+)$`,
);
const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please do|confirm|confirmed|cancel it|thats right|correct|affirmative|absolutely|sim|pode|pode sim|claro|isso mesmo|isso|confirmo|confirmado|cancela|cancele|manda ver|positivo|si|vale|claro que si|adelante|hazlo|dale|correcto)\b/;
const NO = /^(?:no|nope|nah|dont|do not|never mind|nevermind|keep it|leave it|stop|wait|nao|nada|deixa|deixa pra la|esquece|melhor nao|mantenha|mantem|dejalo|olvidalo|mejor no)\b/;

// ---------------------------------------------------------------------------------------------------------------------
// Looking at the tasks.

/** "How is X going": X is a task unless it is a way of asking after the person. */
const HOW_GREETING = new Set(["it", "you", "u", "ya", "yall", "things", "everything", "everyone", "life", "work", "your day", "the day", "your family", "your weekend"]);
const TASKY = /\b(?:isso|isto|aquilo|essa|esse|aquela|aquele|tarefa|tarefas|pesquisa|busca|trabalho|projeto|pedido|proposta|analise|relatorio|resumo|eso|esto|esa|ese|aquello|tarea|tareas|busqueda|investigacion|proyecto|propuesta|analisis|informe)\b/;

const LIST_DONE: RegExp[] = [
  /^(?:what|which|any|anything)\b.*\b(?:finished|completed|done)\b/,
  /^(?:o que|quais|alguma|algo)\b.*\b(?:terminou|acabou|finalizou|concluiu|ficou pronto|pronta)\b/,
  /^(?:que|cuales|alguna|algo)\b.*\b(?:termino|acabo|finalizo|esta listo)\b/,
];

/** A sentence that opens with a question or a request (after the usual politeness), so that "I want that task to..." is not one. */
const lead = (pattern: string): RegExp => new RegExp(`^${LEAD_IN}${pattern}`);

const LIST_ACTIVE: RegExp[] = [
  // English
  lead("(?:whats|what is|what are|which|show|list|give me|tell me|any|how many|do i have)\\b.*\\b(?:tasks?|jobs?|proposals?)\\b"),
  /\b(?:status|progress|updates?|news)\b.*\b(?:tasks?|jobs?|everything|background)\b/,
  /\bwhat(?:s| is| are)?\s+(?:the\s+)?(?:status|progress)\b/,
  /\bwhat(?:s| is| are)\b.*\b(?:running|pending|in progress|going on|queued)\b/,
  /\bwhat\s+(?:are|have)\s+you\s+(?:been\s+)?(?:working on|doing|up to)\b/,
  // Portuguese
  /\b(?:status|andamento|progresso|situacao|estado|novidades?|atualizacoes?|atualizacao)\b.*\b(?:tarefas?|trabalhos?|pedidos?|propostas?|tudo)\b/,
  lead("(?:quais|que|qual|quantas|lista|listar|liste|mostra|mostrar|mostre|me mostra|me mostre|me diz|me diga|me fala)\\b.*\\b(?:tarefas?|trabalhos?)\\b"),
  /\bo que (?:voce|vc|tu)\s+(?:esta|ta|anda|estava)\s+(?:fazendo|rodando|trabalhando)\b/,
  /\bo que (?:esta|ta|anda) (?:rodando|acontecendo|pendente|em andamento)\b/,
  /\bcomo (?:esta|estao|ta|tao|anda|andam|vai|vao)\b.*\btarefas?\b/,
  // Spanish
  /\b(?:estado|estatus|progreso|avance|situacion|novedades?)\b.*\b(?:tareas?|trabajos?|todo)\b/,
  lead("(?:que|cuales|cuantas|lista|listar|muestra|muestrame|dime|enumera)\\b.*\\btareas?\\b"),
  /\bque (?:estas|estan|andas|has estado) (?:haciendo|ejecutando|trabajando)\b/,
  /\bque (?:esta|hay) (?:corriendo|pendiente|en curso|pasando)\b/,
  /\bcomo (?:va|van|esta|estan|anda|andan)\b.*\btareas?\b/,
];

/** The task is named in the sentence: [pattern, what the name must also look like]. */
const NAMED: Array<[RegExp, "greeting" | "tasky" | "any"]> = [
  [/\bhow(?:s| is| are| was)\s+(.+?)\s+(?:going|coming along|coming|progressing|shaping up|doing)\b/, "greeting"],
  [/\b(?:status|progress|update|news)\s+(?:of|on|about|with|for)\s+(.+)$/, "any"],
  [/\bcomo\s+(?:esta|estao|ta|tao|anda|andam|vai|vao)\s+(.+?)(?:\s+(?:indo|andando|ficando))?$/, "tasky"],
  [/\bcomo\s+(?:va|van|esta|estan|anda|andan)\s+(.+)$/, "tasky"],
  [/\b(?:status|andamento|progresso|estado|progreso|avance)\s+(?:d[aeo]s?|sobre|com|de la|del|de)\s+(.+)$/, "any"],
];

/** A short question about the task just talked of, with nothing said of which: "is it done", "ja terminou". */
const BARE_STATUS = /^(?:(?:is|has|did)\s+(?:it|that|this)\s+(?:done|finished|finish|complete|completed|ready|work)|(?:ja\s+)?(?:terminou|acabou|ficou pronto|concluiu)(?:\s+(?:isso|aquilo))?|(?:ya\s+)?(?:termino|acabo|esta listo))$/;

function subjectRoute(subject: string): Route {
  const name = trimNoise(subject);
  if (name !== "") return { kind: "run", tool: "task_status", args: { id: name } };
  return PLURAL_TASKS.test(subject) ? { kind: "run", tool: "list_tasks", args: { filter: "active" } } : { kind: "run", tool: "task_status", args: { id: "last" } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Questions about the person's own things: ask the notes first, so that the answer is theirs or "I do not know".

// "Remind me to call mom" sets a reminder: it is work for the model and its tools. Only a question is a recall.
const RECALL: RegExp[] = [
  // English
  /\bremind me (?:what|where|who|which|how|why|if|whether)\b/,
  /\bwhat did (?:i|we) (?:say|tell you|mention|write|decide|agree|discuss|talk about|note|conclude)\b/,
  /\bdo you (?:remember|recall)\b/,
  /\bwhat do you (?:know|remember|recall) about\b/,
  /\b(?:did|have) i (?:ever )?(?:tell|told|mention|mentioned|say|said)\b/,
  /\bwhere did i (?:put|save|leave|store|note|write)\b/,
  /\bwhat(?:s| is| was| were| are) (?:my|our)\b/,
  // Portuguese
  /\bme lembr(?:a|e|ar|em) (?:o que|do que|qual|quais|quem|onde|sobre)\b/,
  /\bo que (?:eu|a gente|nos|ele|ela) (?:disse|falei|falou|comentei|combinei|combinamos|decidi|decidimos|conversamos|pedi|contei|anotei|escrevi|tinha dito|tinhamos combinado)\b/,
  /\b(?:voce|vc|tu) (?:se )?lembra\b/,
  /(?<!\bme )\blembra (?:do|da|quando|onde)\b/,
  /\bo que (?:voce|vc|tu) (?:sabe|lembra) (?:sobre|de|do|da)\b/,
  /\bonde (?:eu )?(?:coloquei|guardei|salvei|deixei|anotei)\b/,
  /\beu (?:te )?(?:disse|falei|contei) (?:sobre|que)\b/,
  // Spanish
  /\b(?:recuerdame|me recuerdas) (?:cual|cuales|quien|donde|sobre)\b/,
  /\bque (?:te )?(?:dije|comente|mencione|escribi|decidi|dijimos|decidimos|acordamos|hablamos|quedamos)\b/,
  /\bte (?:acuerdas|recuerdas)\b/,
  /\b(?:recuerdas|te acuerdas) (?:de|que|cuando|donde|lo que)\b/,
  /\bque (?:sabes|recuerdas) (?:de|sobre|acerca)\b/,
  /\bdonde (?:puse|guarde|deje|anote)\b/,
];

/**
 * What a spoken request is, as far as it can be told without a model. `awaiting` says that the call has just asked whether to
 * cancel a task, so that a "yes" or a "no" is an answer to that and not a new request.
 */
export function routeUtterance(text: string, awaiting = false): Route {
  const folded = foldText(text);
  if (folded === "") return { kind: "none" };
  const words = folded.split(" ");
  if (awaiting && words.length <= 6) {
    if (NO.test(folded)) return { kind: "answer", yes: false };
    if (YES.test(folded)) return { kind: "answer", yes: true };
  }
  if (words.length > MAX_WORDS) return { kind: "none" };

  const cancel = CANCEL.exec(folded);
  if (cancel && TASK_NOUN.test(cancel[1] as string)) return { kind: "cancel", ref: refOf(cancel[1] as string) };

  if (LIST_DONE.some((re) => re.test(folded))) return { kind: "run", tool: "list_tasks", args: { filter: "done" } };
  for (const [re, needs] of NAMED) {
    const m = re.exec(folded);
    const subject = m?.[1];
    if (subject === undefined) continue;
    if (needs === "greeting" && HOW_GREETING.has(subject)) continue;
    if (needs === "tasky" && !TASKY.test(subject)) continue;
    return subjectRoute(subject);
  }
  if (BARE_STATUS.test(folded)) return { kind: "run", tool: "task_status", args: { id: "last" } };
  if (LIST_ACTIVE.some((re) => re.test(folded))) return { kind: "run", tool: "list_tasks", args: { filter: "active" } };
  if (RECALL.some((re) => re.test(folded))) return { kind: "run", tool: "recall", args: { query: text.trim().slice(0, 400) } };
  return { kind: "none" };
}
