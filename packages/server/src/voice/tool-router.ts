import type { ToolSpec } from "./brain.js";

/**
 * Lightweight deterministic turn-level tool router for live voice calls.
 *
 * Pure 1–3 word greetings, pleasantries, and acknowledgements omit the full tool schema block
 * to save prompt tokens and TTFT on chat turns, while any substantive utterance or follow-up
 * retains the complete tool surface so capabilities (`delegate_task`, `recall`, workspace tools, etc.)
 * are never accidentally hidden.
 *
 * A model that runs on this computer (a "talker") is given fewer tools and always the same ones: a model of a few billion
 * parameters picks the right one more often from seven than from nineteen (measured: 4 of 6 against 3 of 6, and 5 of 6 against
 * 4 of 6), and a tool list that changes from one turn to the next makes the server read the whole prompt again.
 */

const PURE_PLEASANTRY_RE =
  /^(?:hi|hey|hello|howdy|yo|good\s+(?:morning|afternoon|evening|night)|thanks|thank\s+you|thx|cheers|cool|nice|awesome|great|bye|goodbye|see\s+ya|oi|ol[áa]|opa|e\s+a[íi]|bom\s+dia|boa\s+(?:tarde|noite)|obrigad[oa]|valeu|beleza|tchau|at[ée]\s+logo|hola|buenos\s+d[íi]as|buenas\s+(?:tardes|noches)|gracias|adi[óo]s)(?:\s+[a-záàâãéêíóôõúüñç]{1,16})?[.!?,]*$/i;

/**
 * What a talker may call. Everything else the voice can do (read a project, launch an app, look at a page, pause a task) is
 * work for `delegate_task`, which hands it to the assistant's own model. `use_connector` is in the list only while an account is
 * connected, because the host offers it only then.
 */
export const TALKER_TOOL_NAMES: readonly string[] = ["delegate_task", "propose_change", "browse", "use_connector", "list_tasks", "task_status", "cancel_task", "recall"];

/** The tools of a talker, in the order the host gave them. A host that offers none of them is left as it is. */
export function talkerTools(allTools: readonly ToolSpec[]): ToolSpec[] {
  const kept = allTools.filter((t) => TALKER_TOOL_NAMES.includes(t.name));
  return kept.length > 0 ? kept : [...allTools];
}

export function selectToolsForTurn(
  text: string,
  allTools: readonly ToolSpec[],
  recentTools: readonly string[] = [],
  options: { talker?: boolean } = {},
): ToolSpec[] {
  if (allTools.length === 0) return [];
  if (options.talker) return talkerTools(allTools);
  if (recentTools.length > 0) return [...allTools];
  const trimmed = text.trim();
  if (trimmed === "") return [...allTools];
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 3 && PURE_PLEASANTRY_RE.test(trimmed)) {
    return [];
  }
  return [...allTools];
}
