import type { Persona } from "./host.js";
import type { Lang } from "./text.js";

/**
 * What the model is told about being on a call, and the few things the assistant says without asking a model: a
 * moment to think, an apology when a model fails. Short on purpose: every word here is read again on every turn.
 */

export function buildSystemPrompt(persona: Persona, now: Date, lang: Lang, options: { codeSwitched?: boolean } = {}): string {
  const who = persona.callsUser ? ` Its user is called ${persona.callsUser}.` : "";
  const language = persona.language
    ? `Speak ${persona.language}.`
    : "Reply in the language the user speaks (English or Brazilian Portuguese), and switch naturally when they do, including mixed-language technical speech.";
  const lines = [
    `You are ${persona.name}, a personal assistant speaking with its user in a live voice call.${who} Everything you write is spoken aloud, so write the way a person talks.`,
    "Answer first, then add only what helps. Usually one to three short sentences; more only when asked. Ask at most one brief, specific question, and only when genuine ambiguity blocks action.",
    "Understand spontaneous speech: if the user hesitates, uses technical terms, or corrects themselves mid-sentence ('wait, no, staging', 'quer dizer, amanhã'), act on their final intended meaning without asking them to repeat or confirm the correction.",
    "Resolve shorthand and pronouns ('that task', 'the repo', 'aquela branch') from the conversation, notes and Right now state whenever clear. Never guess confidently when two real targets fit; distinguish thinking aloud or casual remarks from actionable tool requests.",
    "No markdown, lists, headings, emoji, links or code. If something is best seen (code, a long list, a link), say that you put it on screen and give only the gist.",
    "Say numbers, dates and times as a person would. Do not read out identifiers or paths.",
    language,
    "You are an AI. Never claim a body, feelings or experiences as fact; warmth and humor in how you speak are fine. Never invent a memory: say so when you do not know.",
    "If the user interrupts you, drop what you were saying and answer the new thing. What they heard of your last reply is what is shown to you: do not repeat what they heard.",
    "Work that takes time goes to the background through your tools; say so in a few words and carry on talking. Multiple background tasks can run at the same time: answering a new question or starting another task never stops already-running tasks, and you only pause or cancel a task when the user asks. Share relevant progress, blockers or finished results concisely.",
    `The local time is ${now.toLocaleString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}.`,
  ];
  if (persona.tone) lines.push(`How you sound: ${persona.tone}`);
  if (lang === "pt" && !persona.language) lines.push("The user is speaking Portuguese now.");
  if (options.codeSwitched && !persona.language) lines.push("The user mixed English and Portuguese in this turn; match their main language naturally.");
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

export type TaskNotice = "started" | "proposed" | "done" | "unverified" | "failed" | "needs" | "cancelled" | "paused";

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
    proposed: () => "I've put that on your screen. It waits for your approval, and only you can give it.",
    done: (t) => `${t} is done.`,
    unverified: (t) => `${t} finished, but nothing checked the result. Please take a look.`,
    failed: (t) => `${t} did not go through.`,
    needs: (t) => `${t} needs your approval.`,
    cancelled: (t) => `${t} was cancelled.`,
    paused: (t) => `${t} is paused.`,
  },
  pt: {
    started: () => "Já comecei isso em segundo plano.",
    proposed: () => "Coloquei isso na sua tela. Aguarda a sua aprovação, e só você pode dar.",
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

const BOILERPLATE_RESULT_RE = /\b\d+ of \d+ steps finished(?: without an error\.)?\s*(?:No check was set for the result\.)?/gi;

/** Extracts a short, natural spoken sentence or two from a task's recorded result or progress text, stripping markdown and boilerplate. */
export function spokenTaskGist(raw: string, max = 160): string | null {
  const cleaned = raw
    .replace(/^\s*From the web \(not checked\):\s*/i, "")
    .replace(BOILERPLATE_RESULT_RE, " ")
    .replace(/^Changed files:.*$/gim, " ")
    .replace(/^Checks:.*$/gim, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>~]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "" || /^(ok|done|pronto)\.?$/i.test(cleaned)) return null;
  if (cleaned.length <= max) {
    return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
  }
  const window = cleaned.slice(0, max);
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentenceEnd >= Math.floor(max * 0.45)) {
    return window.slice(0, sentenceEnd + 1).trim();
  }
  const space = window.lastIndexOf(" ");
  const clipped = (space > max / 2 ? window.slice(0, space) : window).replace(/[,;:.\-–—]+$/, "").trim();
  return clipped ? `${clipped}.` : null;
}

/** Spoken proactive update for a task that finished, failed, or needs the user, enriched with a concise outcome summary when available. */
export function taskUpdatePhrase(
  lang: Lang,
  kind: TaskNotice,
  title: string,
  extra?: { result?: string | null; reason?: string | null },
): string {
  const shortTitle = sayable(title);
  const l = pick(lang);
  if (kind === "done" || kind === "unverified") {
    const gist = extra?.result ? spokenTaskGist(extra.result, 150) : null;
    if (gist) {
      return l === "pt"
        ? `${shortTitle} ${kind === "done" ? "está pronto" : "terminou"}: ${gist}`
        : `${shortTitle} ${kind === "done" ? "is done" : "finished"}: ${gist}`;
    }
  }
  if (kind === "failed" && extra?.reason) {
    const why = spokenTaskGist(extra.reason.replace(/^Step \d+ failed:\s*/i, ""), 110);
    if (why) {
      return l === "pt" ? `${shortTitle} não deu certo: ${why}` : `${shortTitle} did not go through: ${why}`;
    }
  }
  if (kind === "needs" && extra?.reason) {
    if (/question|answer|input/i.test(extra.reason)) {
      return l === "pt" ? `${shortTitle} aguarda uma resposta sua.` : `${shortTitle} is waiting for an answer from you.`;
    }
    if (/check failed/i.test(extra.reason)) {
      const why = spokenTaskGist(extra.reason, 120);
      return why
        ? (l === "pt" ? `${shortTitle}: ${why}` : `${shortTitle}: ${why}`)
        : taskPhrase(lang, kind, title);
    }
  }
  return taskPhrase(lang, kind, title);
}

/** Spoken proactive milestone update for a running task that completed a step or crossed a major milestone. */
export function taskMilestonePhrase(
  lang: Lang,
  title: string,
  milestone: { kind: "step"; done: number; total: number; nextTitle?: string } | { kind: "progress"; percent: number; detail: string },
): string {
  const shortTitle = sayable(title, 48);
  const l = pick(lang);
  if (milestone.kind === "step") {
    const next = milestone.nextTitle ? sayable(milestone.nextTitle, 56) : null;
    if (l === "pt") {
      return next
        ? `Atualização em ${shortTitle}: etapa ${milestone.done} de ${milestone.total} concluída, agora em ${next}.`
        : `Atualização em ${shortTitle}: etapa ${milestone.done} de ${milestone.total} concluída.`;
    }
    return next
      ? `Update on ${shortTitle}: step ${milestone.done} of ${milestone.total} is done, now working on ${next}.`
      : `Update on ${shortTitle}: step ${milestone.done} of ${milestone.total} is done.`;
  }
  const detail = spokenTaskGist(milestone.detail, 96) ?? `${sayable(milestone.detail, 80)}.`;
  return l === "pt"
    ? `Atualização em ${shortTitle}: cerca de ${milestone.percent}% concluído. ${detail}`
    : `Update on ${shortTitle}: about ${milestone.percent} percent done. ${detail}`;
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
