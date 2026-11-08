import { estimateTokens } from "../types.js";

/**
 * What a turn would carry without a memory subsystem: nothing; the last messages of the thread pasted back; or those
 * plus a rolling extractive summary of what fell out of the window. Each is given the same token budget as the
 * assistant, so they differ only in what they keep.
 */

export interface Message {
  at: number;
  thread: string;
  role: "user" | "assistant" | "tool";
  text: string;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function line(m: Message): string {
  return `[${day(m.at)}] ${m.text.replace(/\s+/g, " ").trim()}`;
}

/** The newest messages of the thread that fit in the budget, oldest first, as a chat window would be pasted. */
export function windowContext(history: readonly Message[], thread: string, budgetTokens: number): string {
  const mine = history.filter((m) => m.thread === thread);
  const lines: string[] = [];
  let used = 0;
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const l = line(mine[i] as Message);
    const cost = estimateTokens(l) + 1;
    if (used + cost > budgetTokens) break;
    lines.unshift(l);
    used += cost;
  }
  return lines.join("\n");
}

/**
 * Half the budget for the newest messages whole, half for a summary of the rest: the first words of each older user
 * message, newest first. This is what a rolling summary keeps when it keeps the gist and loses the specifics.
 */
export function summaryContext(history: readonly Message[], thread: string, budgetTokens: number): string {
  const mine = history.filter((m) => m.thread === thread);
  const recent: string[] = [];
  let used = 0;
  let cut = mine.length;
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const l = line(mine[i] as Message);
    const cost = estimateTokens(l) + 1;
    if (used + cost > budgetTokens / 2) break;
    recent.unshift(l);
    used += cost;
    cut = i;
  }
  const older: string[] = [];
  let spent = 0;
  for (let i = cut - 1; i >= 0; i -= 1) {
    const m = mine[i] as Message;
    if (m.role !== "user") continue;
    const gist = m.text.replace(/\s+/g, " ").trim().split(" ").slice(0, 9).join(" ");
    const l = `[${day(m.at)}] ${gist}`;
    const cost = estimateTokens(l) + 1;
    if (spent + cost > budgetTokens / 2) break;
    older.unshift(l);
    spent += cost;
  }
  return [...older, ...recent].join("\n");
}
