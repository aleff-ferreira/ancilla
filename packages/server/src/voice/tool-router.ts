import type { ToolSpec } from "./brain.js";

/**
 * Lightweight deterministic turn-level tool router for live voice calls.
 *
 * Pure 1–3 word greetings, pleasantries, and acknowledgements omit the full tool schema block
 * to save prompt tokens and TTFT on chat turns, while any substantive utterance or follow-up
 * retains the complete tool surface so capabilities (`delegate_task`, `recall`, workspace tools, etc.)
 * are never accidentally hidden.
 */

const PURE_PLEASANTRY_RE =
  /^(?:hi|hey|hello|howdy|yo|good\s+(?:morning|afternoon|evening|night)|thanks|thank\s+you|thx|cheers|cool|nice|awesome|great|bye|goodbye|see\s+ya|oi|ol[áa]|opa|e\s+a[íi]|bom\s+dia|boa\s+(?:tarde|noite)|obrigad[oa]|valeu|beleza|tchau|at[ée]\s+logo|hola|buenos\s+d[íi]as|buenas\s+(?:tardes|noches)|gracias|adi[óo]s)(?:\s+[a-záàâãéêíóôõúüñç]{1,16})?[.!?,]*$/i;

export function selectToolsForTurn(
  text: string,
  allTools: readonly ToolSpec[],
  recentTools: readonly string[] = [],
): ToolSpec[] {
  if (allTools.length === 0) return [];
  if (recentTools.length > 0) return [...allTools];
  const trimmed = text.trim();
  if (trimmed === "") return [...allTools];
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 3 && PURE_PLEASANTRY_RE.test(trimmed)) {
    return [];
  }
  return [...allTools];
}
