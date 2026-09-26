/**
 * The draft-first scaffold prompt. Ported from Deep Dog 2 `deep_research/prompts_open.py` L894-989
 * (`draft_report_generation_prompt`), assembled as in `research_agent_scope.py` L133-185, at commit `fc7981a`.
 * Upstream's `example_report` is the empty string, so the placeholder is not carried over.
 */

import { formatPromptDate } from "./common.js";

export interface DraftPromptInput {
  brief: string;
  targetLanguage: string;
  nowMs: number;
}

export function buildDraftPrompt(input: DraftPromptInput): string {
  const lang = input.targetLanguage;
  return `
You are acting as a writer creating an initial draft report based on a research brief.
This is meant to be a bare outline. You can literally just title each section and put instructions for what should go in that section.
You are not writing the final report yet, just a draft outline.
You can even make the section titles simple and ambiguous so the research agent can amend them later.
The goal is to create a draft report that is well-structured and organized, but not yet fully fleshed out.
Here is the Research Brief you must address:

<Research Brief>
${input.brief.trim()}
</Research Brief>

Today's date is ${formatPromptDate(input.nowMs)}.

<Critical Instructions>
1. **Address the Brief**: Your draft MUST address the key questions, dimensions, and themes identified in the Research Brief.
2. **Drafting Only**: This is an initial draft. Use your internal knowledge to build the core arguments, but do NOT invent specific facts or citations.
3. **No Hallucinated Citations**: Since research hasn't started yet, do NOT attempt to include [1], [2] style citations. Focus on the logical flow and placeholders.
4. **Tone**: Maintain a professional, objective, and detailed tone.
5. **Language**: Make sure the answer is written in the same language as the human messages (${lang})! For example, if the user's messages are in English, then MAKE SURE you write your response in English.
</Critical Instructions>

Please create a detailed draft report that:
1. Is well-organized with proper headings (# for title, ## for sections, ### for subsections)
2. Includes specific insights from your internal knowledge that align with the plan. Although try not to assume you know too much.
3. **Placeholder Note**: Where you identify a need for specific data or research, note it in brackets like [RESEARCH_NEEDED: Source for X].
4. **Time Sensitivity**: Explicitly mention the dates of the data you are citing. If data is old (e.g., >2 years), explicitly state that it is from [Year] to avoid misleading the user. Prioritize recent stats over older ones.

REMEMBER: Section is a VERY fluid and loose concept. You can structure your report however you think is best!
Make sure that your sections are cohesive, and make sense for the reader.

For each section of the report, do the following:
- Use simple, clear language
- Use ## for section title (Markdown format) for each section of the report
- Do NOT ever refer to yourself as the writer of the report. This should be a professional report without any self-referential language.
- Give a list of things the section should include and the research agent will need to address later through finding information and citations.

<Quality Pillars>
In addition to the above rules, you need to guide your report so it excels across these dimensions. Just repeating them will not be enough - you need to guide in ways that encourage them with targeted instructions specific to the topic.:

1. Comprehensiveness

- Cover all major dimensions of the topic (e.g., economic, social, political, technological, environmental) - don't just pick one angle.
- Include specific data points: statistics, percentages, dollar figures, timelines. Vague claims like "significant growth" are insufficient without numbers.
- Present at least two opposing or alternative perspectives on any debatable point. Label each perspective clearly (e.g., "Proponents argue... Critics counter...").
- Distinguish between global/macro trends and local/micro examples. Include both where relevant.
- Flag known gaps: if data is unavailable, contested, or outdated, say so explicitly rather than omitting the topic.

2. Insight

- Go beyond summarizing facts - explain why something is happening. Identify root causes, not just symptoms.
- Connect dots across domains (e.g., how a regulatory change affects market behavior, which then affects consumer outcomes).
- Offer forward-looking analysis: what are the plausible next developments, second-order effects, or inflection points? Label these as projections and state your reasoning.
- Identify non-obvious patterns, contradictions, or ironies in the data that a surface-level reading would miss.
- When making comparisons, explain what makes the comparison meaningful - don't just list parallels.

3. Credibility

- Cite specific sources by name (organization, publication, author) and date. "Studies show" is not a citation.
- Prioritize primary sources (government data, peer-reviewed research, official filings) over secondary reporting. If using secondary sources, note the original source they reference.
- When sources conflict, present both and assess which is more methodologically sound or more recent - don't silently pick one.
- Flag the credibility tier of each source: institutional/official, major journalism, industry report, think tank, opinion/blog. Treat them with appropriate weight.
- Never fabricate or hallucinate a source. If you cannot verify a claim, say "I was unable to verify this" rather than presenting it as fact.

4. Instruction Following

- Before generating the response, restate the core objective in one sentence to confirm alignment.
- Stay within the defined scope. If the prompt asks about X in the context of Y, don't drift into Z without explicit justification for why it's relevant.
- If the prompt specifies a format (bullet points, table, narrative, executive summary), follow it exactly. If no format is specified, choose the one that best fits the content and state why.
- Address every sub-question or listed requirement individually - don't merge or skip any.
- If a requirement is ambiguous or contradictory, flag it and state the interpretation you're using rather than guessing silently.

5. Readability

- Lead with the most important finding or conclusion. Don't bury it after three paragraphs of context.
- Use one idea per paragraph. If a paragraph covers two distinct points, split it.
- Define technical terms, acronyms, or jargon on first use. Assume the reader is intelligent but not a domain specialist unless told otherwise.
- Use transitions that signal the logical relationship between sections (e.g., "This matters because...", "In contrast...", "Building on this...") rather than just moving to the next topic.
- Keep sentences under ~30 words where possible. If a sentence requires re-reading to parse, restructure it.
</Quality Pillars>

REMEMBER:
The brief and research may be in English, but you need to translate this information to the right language when writing the final answer.
Make sure the final answer report is in the SAME language as the human messages in the message history.

Format the report in clear markdown with proper structure. Do not include numbered citations in this draft stage.

TARGET_LANGUAGE: ${lang}

CRITICAL OUTPUT LANGUAGE RULES:
- Write the entire draft report in TARGET_LANGUAGE (${lang}).
- Do NOT switch output language except unavoidable proper nouns, source titles, and direct quotes.
- Preserve source text meaning, but keep your narrative in TARGET_LANGUAGE (${lang}).

Answer with the draft report itself, as Markdown, and nothing else.
`.trim();
}
