/**
 * The final report prompt. Ported from Deep Dog 2 `deep_research/prompts_open.py` L747-891
 * (`final_report_write_prompt`) with the registry and curated-text blocks built as in
 * `multi_agent_supervisor.py` L889-921 and the retry nudge from L1005-1010, at commit `fc7981a`.
 *
 * Upstream wrote the report at the tail of the supervisor conversation, so the brief, the draft, the findings
 * and the last denoise reflection were already in context. Muse exec is one shot, so they are spelled out here.
 * The example code in the citation rules is `[A4-S2]` rather than upstream's `[A4-S2#3]` because the engine
 * assigns codes per saved source, not per search hit.
 */

import type { FinalRegistryEntry } from "../citations.js";
import { NOTES_BLOCK_CHAR_BUDGET, notesBlock } from "../notes.js";
import { formatPromptDate } from "./common.js";

export interface WriterPromptInput {
  question: string;
  brief: string;
  draft: string | null;
  notes: string[];
  /** The supervisor's most recent denoise reflection, the anti-fabrication guardrail. */
  lastReflection: string | null;
  registry: FinalRegistryEntry[];
  targetLanguage: string;
  nowMs: number;
  /** True when research stopped early and the writer should say so where evidence is thin. */
  salvage: boolean;
}

/** Appended on the second writing attempt (upstream `write_final_report` L1005-1010). */
export const WRITER_RETRY_NUDGE =
  "Continue the research. Produce a complete, factual final report in the target language using the research " +
  "findings above. Write the finished report, not a copy of the initial draft or outline. Include inline source " +
  "codes from the registry. Do not output CitationPlanList tags or a Sources section.";

export function buildSourceRegistryBlock(registry: FinalRegistryEntry[]): string {
  if (registry.length === 0) return "(no sources available)";
  return registry
    .map((entry) => {
      const title = (entry.title ?? "").trim() || "Untitled";
      const line = `[${entry.code}] ${title} (${entry.url})`;
      return entry.reason ? `${line}\n    Relevance: ${entry.reason}` : line;
    })
    .join("\n");
}

export function buildCuratedTextBlock(registry: FinalRegistryEntry[]): string {
  const parts = registry
    .filter((entry) => (entry.excerpt ?? "").trim())
    .map((entry) => `[${entry.code}] ${(entry.title ?? "").trim() || "Untitled"} (${entry.url})\n${(entry.excerpt ?? "").trim()}`);
  return parts.length > 0
    ? parts.join("\n\n---\n\n")
    : "(No additional source text - the sources are already covered in the research findings above.)";
}

/** The curated sources without their excerpts: what the writer gets when the excerpts would not fit the budget. */
export function buildCuratedListBlock(registry: FinalRegistryEntry[]): string {
  const parts = registry
    .filter((entry) => (entry.excerpt ?? "").trim())
    .map((entry) => `[${entry.code}] ${(entry.title ?? "").trim() || "Untitled"} (${entry.url})${entry.reason ? ` - ${entry.reason}` : ""}`);
  if (parts.length === 0) return "(No additional source text - the sources are already covered in the research findings above.)";
  return `(Source excerpts were left out to keep this prompt within its budget; cite these sources from the research findings above.)\n${parts.join("\n")}`;
}

/**
 * The material blocks of the writer prompt, budgeted: the notes are compacted oldest first (see `notes.ts`), and
 * when the notes and the curated excerpts together still exceed the budget the excerpts give way, because the
 * findings already cite every source and the registry keeps each source's title, URL and relevance.
 */
export function writerMaterial(notes: string[], registry: FinalRegistryEntry[], budget: number = NOTES_BLOCK_CHAR_BUDGET): { notes: string; curated: string; excerptsDropped: boolean } {
  const block = notes.length > 0 ? notesBlock(notes, budget) : "(no research findings were collected)";
  const full = buildCuratedTextBlock(registry);
  if (block.length + full.length <= budget) return { notes: block, curated: full, excerptsDropped: false };
  return { notes: block, curated: buildCuratedListBlock(registry), excerptsDropped: true };
}

export function buildWriterPrompt(input: WriterPromptInput): string {
  const lang = input.targetLanguage;
  const material = writerMaterial(input.notes, input.registry);
  const notes = material.notes;
  const draft = input.draft?.trim() ? input.draft.trim() : "(no draft was written)";
  const reflection = input.lastReflection?.trim() ? input.lastReflection.trim() : "(no supervisor reflection is available)";
  const salvageNote = input.salvage
    ? "\nNOTE: Research was stopped before the supervisor concluded. Write from the findings that exist, caveat inline where evidence is thin, and never invent what was not found.\n"
    : "";

  return `
You are writing the FINAL REPORT for the deep-research conversation below. The research findings, the research brief, and the draft report are given in this message - do not ask for them, use them directly.

Today's date is ${formatPromptDate(input.nowMs)}.

TARGET_LANGUAGE: ${lang}

CRITICAL OUTPUT LANGUAGE RULES:
- Write the entire final report in TARGET_LANGUAGE (${lang}).
- Do NOT switch output language except unavoidable proper nouns, source titles, and direct quotes.
- Preserve source text meaning, but keep your narrative in TARGET_LANGUAGE (${lang}).

<Final Thinking - anti-fabrication + residual gaps guardrail>
Before writing, read the supervisor's most recent denoise reflection (the <Supervisor Final Reflection> block below). It names the Open Gaps and Residual Gaps the supervisor could not fully close, each typed by defect [Quantification, Contradiction, Named-alternative, Futurity, Causal, Credibility, Recency, Contrarian, Thin]. Treat those as a guardrail:
- Do NOT invent specific figures, facts, names, or citations to fill them. If the supervisor says a gap is "no primary filing found", do NOT invent a figure. Write briefly and factually from what was found, using the best-available caveat from the residual list.
- Do NOT add a standalone "Limitations" section. Instead caveat INLINE and briefly: "Evidence for X is limited to one secondary source; no primary filing found" - then move on.
- Flag the credibility tier inline when relevant.
</Final Thinking>
${salvageNote}
Write a comprehensive, well-structured report that:
1. Is well-organized with proper headings (# for title, ## for sections, ### for subsections)
2. Includes specific facts and insights from the research
3. Provides a balanced, thorough analysis. Be as comprehensive as possible, and include all information that is relevant to the overall research question. People are using you for deep research and will expect detailed, comprehensive answers.
4. **Verbosity and Detail**: Every major claim or theme MUST be supported by at least one concrete example, case study, or specific data point found in the research. Do not just state a trend; show the evidence.

You can structure your report in a number of different ways. For example:
- To compare two things: 1/ intro, 2/ overview of topic A, 3/ overview of topic B, 4/ comparison, 5/ conclusion.
- To return a list or table: a single section with the list/table, or one section per item. No intro or conclusion needed for lists.
- To summarize or give an overview: 1/ overview, 2/ concept 1, 3/ concept 2, 4/ concept 3, 5/ conclusion.

REMEMBER: Section structure is a fluid concept. Structure the report however you think is best, so long as sections are cohesive.

For each section of the report, do the following:
- Have an explicit discussion in simple, clear language.
- DO NOT oversimplify. Clarify when a concept is ambiguous. I don't like oversimplification.
- DO NOT list facts in bullet points. write in paragraph form.
- If there are theoretical frameworks, provide a detailed application of theoretical frameworks.
- For comparison and conclusion, include a summary table.
- Use ## for section title (Markdown format) for each section of the report.
- Do NOT ever refer to yourself as the writer of the report. This should be a professional report without any self-referential language.
- Do not say what you are doing in the report. Just write the report without any commentary from yourself.
- Each section should be as long as necessary to deeply answer the question with the information you have gathered. It is expected that sections will be fairly long and verbose. You are writing a deep research report, and users will expect a thorough answer and insights by following the Insightfulness Rules.

<Insightfulness Rules>
- Granular breakdown - Does the response have a granular breakdown of the topics and their specific causes and specific impacts?
- Detailed mapping table - Does the response have a detailed table mapping these causes and effects?
- Nuanced discussion - Does the response have detailed exploration of the topic and explicit discussion?
</Insightfulness Rules>

<Verbosity and Examples Rules>
- **No Generalizations**: Avoid broad statements without backing them up. If you say "Regulations are tightening," you must name a specific law or country mentioned in the findings.
- **Example Density**: Aim to include multiple specific examples or "case studies" per major ## heading, unless the user requests a briefer format.
- **Deep Dive**: If the findings contain a detailed description of an event or a product, do not summarize it into a single sentence. Give it a full paragraph (or more) to preserve the nuance. Adjust depth based on user preferences.
- **Length**: Each ## section should typically be at least 3-5 paragraphs long (aim for 300-600 words per major section), unless the user requests a more concise summary.
</Verbosity and Examples Rules>

<Helpfulness Rules>
- Satisfying user intent - Does the response directly address the user's request or question?
- Ease of understanding - Is the response fluent, coherent, and logically structured?
- Accuracy - Are the facts, reasoning, and explanations correct?
- Appropriate language - Is the tone suitable and professional, without unnecessary jargon or confusing phrasing?
</Helpfulness Rules>

<Quality Pillars>
Ensure your report excels across these dimensions:

1. Comprehensiveness
- Cover all major dimensions of the topic (e.g., economic, social, political, technological, environmental) - don't just pick one angle.
- Include specific data points: statistics, percentages, dollar figures, timelines. Vague claims like "significant growth" are insufficient without numbers.
- Present at least two opposing or alternative perspectives on any debatable point. Label each perspective clearly (e.g., "Proponents argue... Critics counter...").
- Distinguish between global/macro trends and local/micro examples. Include both where relevant.
- Flag known gaps: if data is unavailable, contested, or outdated, say so explicitly rather than omitting the topic.
- Comprehensiveness is evidence-backed coverage, not length. Never dilute dense findings with filler to look comprehensive.

2. Insight
- Go beyond summarizing facts - explain why something is happening. Identify root causes, not just symptoms.
- Connect dots across domains (e.g., how a regulatory change affects market behavior, which then affects consumer outcomes).
- Offer forward-looking analysis: what are the plausible next developments, second-order effects, or inflection points? Label these as projections and state your reasoning.
- Identify non-obvious patterns, contradictions, or ironies in the data that a surface-level reading would miss.
- When making comparisons, explain what makes the comparison meaningful - don't just list parallels.

3. Credibility
- Cite specific sources by name (organization, publication, author) and date. "Studies show" is not a citation.
- Prioritize primary sources (government data, peer-reviewed research, official filings) over secondary reporting. If using secondary sources, note the original source they reference.
- When sources conflict, present both and assess which is more methodologically sound or more recent - don't silently pick one. If the supervisor's denoise marked a section [CONTRADICTED] or [UNSUPPORTED], you MUST present BOTH positions with their source codes and say which is more methodologically sound or more recent.
- Flag the credibility tier of each source: institutional/official, major journalism, industry report, think tank, opinion/blog. Treat them with appropriate weight.
- Never fabricate or hallucinate a source. If you cannot verify a claim, say "I was unable to verify this" rather than presenting it as fact.

4. Instruction Following
- Before generating the response, restate the core objective in one sentence to confirm alignment.
- Stay within the defined scope. If the prompt asks about X in the context of Y, don't drift into Z without explicit justification for why it's relevant.
- If the prompt specifies a format (bullet points, table, narrative, executive summary), follow it exactly. If no format is specified, choose the one that best fits the content and state why.
- Address every sub-question or listed requirement individually - don't merge or skip any.
- If a requirement is ambiguous or contradictory, flag it and state the interpretation you're using rather than guessing silently.

5. Readability
- Answer first: open with a concise executive summary (<=300 words) that states the direct answer to the question; restate that answer explicitly in the conclusion.
- Information density: every sentence should add new information. Do not restate the same point across sections. Cut filler ("It is important to note that...", "In today's landscape..."). Prefer specific numbers, dates, and named entities over vague qualifiers ("significant", "growing").
- No padding: if a section lacks verified substance, state the gap explicitly (the supervisor's denoise reflection names residual gaps) instead of inflating with generic prose.
- Direct tone: state findings declaratively. Hedge only where evidence is genuinely mixed, and then say what makes it uncertain.
- Tables for comparisons: when comparing 3+ items on shared attributes, prefer a compact table over prose lists. Keep prose for argument and narrative.
- Lead with the most important finding or conclusion. Don't bury it after three paragraphs of context.
- Use one idea per paragraph. If a paragraph covers two distinct points, split it.
- Define technical terms, acronyms, or jargon on first use. Assume the reader is intelligent but not a domain specialist unless told otherwise.
- Use transitions that signal the logical relationship between sections (e.g., "This matters because...", "In contrast...", "Building on this...") rather than just moving to the next topic.
- Keep sentences under ~30 words where possible. If a sentence requires re-reading to parse, restructure it.
</Quality Pillars>

<Citation Rules>
- The <SOURCE REGISTRY> below is the ONLY authoritative list of sources for this report.
- Cite facts and claims inline using the exact bracket code from the registry, e.g. [A4-S2] or [C1], immediately after the fact or claim. Combine codes like [A4-S2][C1] when multiple sources support the same point.
- NEVER write a URL anywhere in the report body.
- NEVER invent a code that is not in the <SOURCE REGISTRY>.
- Do NOT output a <CitationPlanList> block.
- Do NOT output a ## Sources section - it is appended automatically.

**CRITICAL CITATION DENSITY + HONESTY RULES:**
- EVERY paragraph containing factual claims, data, statistics, or analysis MUST include at least one citation.
- For high-impact quantified claims with 2x independent secondary sources agreeing on the same figure, CITE BOTH TOGETHER to demonstrate quality, e.g. "Revenue was $10M in 2023 [A4-S2][C1]" - only when BOTH curated texts contain that exact figure.
- ONLY cite a source if its curated text / registry snippet actually contains the exact claim you are making. If unsure, do NOT cite it.
- One citation cluster per claim: group corroborating sources at the end of the claim; do not spread them artificially. If the same source is used multiple times in a paragraph, one citation at the end of the cluster is enough.
- Aim to cite most of the sources in the registry ACROSS the report by using diverse sources in different paragraphs/sections, not by stuffing irrelevant sources into one paragraph.
- For single-secondary coverage, caveat inline: "single secondary source, no primary found".
- If you write a paragraph without citations, STOP and find a source from the registry to support it.
- NEVER TRY TO PRETEND THAT A SOURCE SAID SOMETHING THAT IT DID NOT SAY. FAKING CITATIONS IS A FAIL!
</Citation Rules>

<Research Brief>
${input.brief.trim()}
</Research Brief>

<Draft Report>
${draft}
</Draft Report>

ORIGINAL USER QUESTION (verbatim - the report MUST answer this):
${input.question.trim()}

<Research Findings>
${notes}
</Research Findings>

<Supervisor Final Reflection>
${reflection}
</Supervisor Final Reflection>

<SOURCE REGISTRY>
${buildSourceRegistryBlock(input.registry)}
</SOURCE REGISTRY>

<CURATED SOURCE FULL TEXT>
${material.curated}
</CURATED SOURCE FULL TEXT>

Write the final report now. Answer with the report itself, as Markdown, and nothing else.
`.trim();
}
