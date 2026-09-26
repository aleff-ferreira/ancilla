/**
 * The research brief prompt. Ported from Deep Dog 2 `deep_research/prompts_open.py` L69-127
 * (`transform_messages_into_research_topic_human_msg_prompt`), assembled as in `research_agent_scope.py` L78-131,
 * at commit `fc7981a`. Upstream appended a Pydantic JSON schema; here the tail asks for a fenced JSON object.
 */

import { formatPromptDate, jsonFence } from "./common.js";

export interface BriefPromptInput {
  question: string;
  nowMs: number;
}

export const BRIEF_JSON_CONTRACT = jsonFence(`{
  "research_brief": "<the detailed research question, written in target_language>",
  "input_language": "<the language the user's message is written in, e.g. \\"English\\">",
  "target_language": "<identical to input_language>"
}`);

/** Appended on the second attempt when the first answer had no usable JSON block. */
export const BRIEF_RETRY_NUDGE =
  "Your previous answer did not contain a valid fenced JSON object. Answer again with ONLY the fenced JSON object " +
  "described in <Response Format>, with the three keys research_brief, input_language and target_language.";

export function buildBriefPrompt(input: BriefPromptInput): string {
  return `
You will be given a set of messages that have been exchanged so far between yourself and the user.
Your job is to translate these messages into a more detailed and concrete research question that will be used to guide the research.

The messages that have been exchanged so far between yourself and the user are:
<Messages>
${input.question.trim()}
</Messages>

<Language Detection - read the <Messages> block FIRST>
1. Determine the language the user's messages are literally written in - from the actual script/characters in <Messages>, and nothing else.
2. input_language must name that language exactly (e.g. "English", "中文").
3. target_language must be IDENTICAL to input_language.
4. Do NOT infer the language from the research topic, from the language used in these instructions, or from your own preference. If the user's message is written in English, both fields are "English".
5. Write the research brief in target_language (the same language as the user's messages).
</Language Detection>

CRITICAL: Make sure the answer is written in the same language as the human messages!
For example, if the user's messages are in English, then MAKE SURE you write your response in English. If the user's messages are in Chinese, then MAKE SURE you write your entire response in Chinese.
This is critical. The user will only understand the answer if it is written in the same language as their input message.

Today's date is ${formatPromptDate(input.nowMs)}.

You will return a single research question that will be used to guide the research.
You must also identify and return: (a) input_language - the language the user's messages are written in (see <Language Detection>); (b) target_language - the language the report should be written in. Both must be IDENTICAL.

Guidelines:
1. Maximize Specificity and Detail
- Include all known user preferences and explicitly list key attributes or dimensions to consider.
- It is important that all details from the user are included in the instructions.

2. Handle Unstated Dimensions Carefully
- When research quality requires considering additional dimensions that the user hasn't specified, acknowledge them as open considerations rather than assumed preferences.
- Example: Instead of assuming "budget-friendly options," say "consider all price ranges unless cost constraints are specified."
- Only mention dimensions that are genuinely necessary for comprehensive research in that domain.

3. Avoid Unwarranted Assumptions
- Never invent specific user preferences, constraints, or requirements that weren't stated.
- If the user hasn't provided a particular detail, explicitly note this lack of specification.
- Guide the researcher to treat unspecified aspects as flexible rather than making assumptions.

4. Distinguish Between Research Scope and User Preferences
- Research scope: What topics/dimensions should be investigated (can be broader than user's explicit mentions)
- User preferences: Specific constraints, requirements, or preferences (must only include what user stated)
- Example: "Research coffee quality factors (including bean sourcing, roasting methods, brewing techniques) for San Francisco coffee shops, with primary focus on taste as specified by the user."

5. Use the First Person
- Phrase the request from the perspective of the user.

6. Sources
- If specific sources should be prioritized, specify them in the research question.
- For product and travel research, prefer linking directly to official or primary websites (e.g., official brand sites, manufacturer pages, or reputable e-commerce platforms like Amazon for user reviews) rather than aggregator sites or SEO-heavy blogs.
- For academic or scientific queries, prefer linking directly to the original paper or official journal publication rather than survey papers or secondary summaries.
- For people, try linking directly to their LinkedIn profile, or their personal website if they have one.
- If the query is in a specific language, prioritize sources published in that language.

REMEMBER:
Make sure the research brief is in the SAME language as the human messages in the message history - i.e., in input_language.

<Response Format>
Answer with exactly one fenced JSON object and nothing after it. Any reasoning goes before the block, never inside it.
${BRIEF_JSON_CONTRACT}
</Response Format>
`.trim();
}
