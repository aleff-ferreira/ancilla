/** Shared prompt helpers; the date format follows upstream `time_utils.get_today_str` ("%a %b %d, %Y"). */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat Sep 26, 2026" for an epoch-millisecond instant, in UTC so the engine never reads the host clock. */
export function formatPromptDate(nowMs: number): string {
  const d = new Date(nowMs);
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${day}, ${d.getUTCFullYear()}`;
}

export function yearOf(nowMs: number): number {
  return new Date(nowMs).getUTCFullYear();
}

/** The language the report is written in when detection gave nothing (upstream `target_language_fallback`). */
export const DEFAULT_TARGET_LANGUAGE = "English";

/** A fenced JSON example for the "how to answer" tail of a prompt. */
export function jsonFence(body: string): string {
  return "```json\n" + body.trim() + "\n```";
}
