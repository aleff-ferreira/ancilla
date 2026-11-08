import type { Persona } from "./host.js";
import type { Lang } from "./text.js";

/**
 * What the model is told about being on a call, and the few things the assistant says without asking a model: a
 * moment to think, an apology when a model fails. Short on purpose: every word here is read again on every turn.
 */

export function buildSystemPrompt(persona: Persona, now: Date, lang: Lang): string {
  const who = persona.callsUser ? ` Its user is called ${persona.callsUser}.` : "";
  const language = persona.language
    ? `Speak ${persona.language}.`
    : "Reply in the language the user speaks (English or Brazilian Portuguese), and switch when they do.";
  const lines = [
    `You are ${persona.name}, a personal assistant speaking with its user in a live voice call.${who} Everything you write is spoken aloud, so write the way a person talks.`,
    "Answer first, then add only what helps. Usually one to three short sentences; more only when asked. Ask at most one question, and only when you cannot go on without it.",
    "No markdown, lists, headings, emoji, links or code. If something is best seen (code, a long list, a link), say that you put it on screen and give only the gist.",
    "Say numbers, dates and times as a person would. Do not read out identifiers or paths.",
    language,
    "You are an AI. Never claim a body, feelings or experiences as fact; warmth and humor in how you speak are fine. Never invent a memory: say so when you do not know.",
    "If the user interrupts you, drop what you were saying and answer the new thing. What they heard of your last reply is what is shown to you: do not repeat what they heard.",
    "Work that takes time goes to the background through your tools; say so in a few words and carry on talking. Report what happens when it is asked or when something needs the user.",
    `The local time is ${now.toLocaleString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}.`,
  ];
  if (persona.tone) lines.push(`How you sound: ${persona.tone}`);
  if (lang === "pt" && !persona.language) lines.push("The user is speaking Portuguese now.");
  return lines.join("\n");
}

const THINKING: Record<"en" | "pt", string[]> = {
  en: ["One moment.", "Let me think.", "Let me check.", "Give me a second."],
  pt: ["Um momento.", "Deixa eu pensar.", "Deixa eu ver.", "Só um segundo."],
};

const FAILED: Record<"en" | "pt", string> = {
  en: "Sorry, I lost my train of thought. Could you say that again?",
  pt: "Desculpa, perdi o fio. Pode repetir?",
};

const TOO_QUIET: Record<"en" | "pt", string> = {
  en: "I could not hear anything. Could you say that again?",
  pt: "Não consegui ouvir. Pode repetir?",
};

function pick(lang: Lang): "en" | "pt" {
  return lang === "pt" ? "pt" : "en";
}

const DIDNT_CATCH: Record<"en" | "pt", string> = {
  en: "Sorry, I didn't catch that.",
  pt: "Desculpa, não entendi.",
};

/** Said when someone spoke and nothing could be made out of it. */
export function didntCatchPhrase(lang: Lang): string {
  return DIDNT_CATCH[pick(lang)];
}

export type TaskNotice = "started" | "done" | "unverified" | "failed" | "needs" | "cancelled" | "paused";

/** A task's title, short enough to be said: cut at a word, never in the middle of one. */
export function sayable(title: string, max = 60): string {
  const flat = title.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[,;:.\-–—]+$/, "")}...`;
}

const TASK: Record<"en" | "pt", Record<TaskNotice, (title: string) => string>> = {
  en: {
    started: () => "I've started that in the background.",
    done: (t) => `${t} is done.`,
    unverified: (t) => `${t} finished, but nothing checked the result. Please take a look.`,
    failed: (t) => `${t} did not go through.`,
    needs: (t) => `${t} needs your approval.`,
    cancelled: (t) => `${t} was cancelled.`,
    paused: (t) => `${t} is paused.`,
  },
  pt: {
    started: () => "Já comecei isso em segundo plano.",
    done: (t) => `${t} está pronto.`,
    unverified: (t) => `${t} terminou, mas nada conferiu o resultado. Dá uma olhada, por favor.`,
    failed: (t) => `${t} não deu certo.`,
    needs: (t) => `${t} precisa da sua aprovação.`,
    cancelled: (t) => `${t} foi cancelada.`,
    paused: (t) => `${t} está pausada.`,
  },
};

/** What is said about a task, in the language of the call. */
export function taskPhrase(lang: Lang, kind: TaskNotice, title: string): string {
  return TASK[pick(lang)][kind](sayable(title));
}

const AWAY: Record<"en" | "pt", { lead: string; more: (n: number) => string }> = {
  en: { lead: "While you were away:", more: (n) => `And ${n} more.` },
  pt: { lead: "Enquanto você esteve fora:", more: (n) => `E mais ${n}.` },
};

/** What a call opens with when work finished, failed or waits on the person since they last talked: the first few, then how many more. */
export function openingPhrase(lang: Lang, items: readonly { notice: TaskNotice; title: string }[], more = 0): string {
  const bank = AWAY[pick(lang)];
  return [bank.lead, ...items.map((item) => taskPhrase(lang, item.notice, item.title)), ...(more > 0 ? [bank.more(more)] : [])].join(" ");
}

/** A short phrase to say while a model or a tool takes its time. It varies with the turn so that it is not always the same. */
export function thinkingPhrase(lang: Lang, turn: number): string {
  const bank = THINKING[pick(lang)];
  return bank[turn % bank.length] as string;
}

export function failedPhrase(lang: Lang): string {
  return FAILED[pick(lang)];
}

export function tooQuietPhrase(lang: Lang): string {
  return TOO_QUIET[pick(lang)];
}
