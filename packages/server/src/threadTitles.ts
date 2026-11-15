// Thread titling heuristics and LLM prompt generation
import { PLACEHOLDER_TITLE } from "@ancilla/daemon";
// Extracts a concise thread title from the initial prompt line.
// Skips code fences, removes markdown decoration, collapses whitespace,
// and caps the result to 72 characters (breaking at a word boundary when possible).
export function deriveTitle(inputText: string): string | null {
  const lineArray = inputText.split(/\r?\n/);
  let chosenLine: string | null = null;
  for (const rawLine of lineArray) {
    const strippedLine = rawLine.trim().replace(/^```[^\s]*\s*/, "");
    if (strippedLine.length > 0) {
      chosenLine = strippedLine;
      break;
    }
  }
  if (!chosenLine) {
    return null;
  }
  const cleanLine = chosenLine.replace(/^[#>*\-\s]+/, "").replace(/\s+/g, " ").trim();
  if (!cleanLine) {
    return null;
  }
  if (cleanLine.length <= 72) {
    return cleanLine;
  }
  const prefixSlice = cleanLine.slice(0, 72);
  const wordBoundary = prefixSlice.lastIndexOf(" ");
  const truncatedText = wordBoundary > 40 ? prefixSlice.slice(0, wordBoundary) : prefixSlice;
  return `${truncatedText.trimEnd()}...`;
}
// Maximum character budget allocated to initial user message during title generation.
export const TITLE_PROMPT_MAX_CHARS: number = 8_000;
const TRUNCATION_NOTICE = "\n[Content truncated]\n";
// Bounds input prompt text within a character budget while retaining both head and tail context.
export function limitTitleText(sourceText: string, maxBudget: number): string {
  if (sourceText.length <= maxBudget) {
    return sourceText;
  }
  if (maxBudget <= TRUNCATION_NOTICE.length) {
    return "";
  }
  const usableBudget = maxBudget - TRUNCATION_NOTICE.length;
  const headPortion = Math.ceil(usableBudget / 2);
  const tailPortion = usableBudget - headPortion;
  const headSlice = sourceText.slice(0, headPortion);
  const tailSlice = tailPortion > 0 ? sourceText.slice(-tailPortion) : "";
  return `${headSlice}${TRUNCATION_NOTICE}${tailSlice}`;
}
const TITLE_SYSTEM_PROMPT = [
  "Generate a title that will help the user recognize this Ancilla thread weeks later.",
  "Reply with ONLY the title text. Do not provide quotes, introductory labels, or JSON formatting.",
  "",
  "Synthesize the essential topic:",
  "- Identify the core subject, component, or objective of the user's inquiry.",
  "- Describe the desired change or query outcome concisely.",
  "- Ignore incidental procedural notes, formatting demands, or tool details.",
  "",
  "Guidance rules:",
  "- Length: between 3 and 8 words.",
  "- Format: concise action phrase or noun phrase.",
  "- State the ultimate deliverable rather than intermediate plans or artifacts.",
  "- Exclude model tags, subagent names, and generic conversational filler.",
].join("\n");
// Builds LLM prompt for generating informative thread titles.
export function buildThreadTitlePrompt(initialUserMessage: string): string {
  const boundedContent = limitTitleText(initialUserMessage.trim(), TITLE_PROMPT_MAX_CHARS);
  return `${TITLE_SYSTEM_PROMPT}\n\nUser message:\n${boundedContent}`;
}
interface ExecStreamPayload {
  payload_type?: string;
  kind?: string;
  payload?: {
    kind?: string;
    terminal?: string;
    text?: string;
    [field: string]: unknown;
  };
  [field: string]: unknown;
}
// Extracts generated title text from model execution events.
export function parseExecTitle(streamStdout: string): string | null {
  let terminalResult: string | null = null;
  let concatenatedDeltas = "";
  const rawStreamLines = streamStdout.split("\n");
  for (const streamLine of rawStreamLines) {
    const trimmedPayload = streamLine.trim();
    if (!trimmedPayload.startsWith("{")) {
      continue;
    }
    let parsedEvent: ExecStreamPayload;
    try {
      parsedEvent = JSON.parse(trimmedPayload) as ExecStreamPayload;
    } catch {
      continue;
    }
    if (typeof parsedEvent !== "object" || parsedEvent === null) {
      continue;
    }
    const eventPayload = typeof parsedEvent.payload === "object" && parsedEvent.payload !== null
      ? parsedEvent.payload
      : null;
    if (!eventPayload) {
      continue;
    }
    const itemText = typeof eventPayload.text === "string" ? eventPayload.text : "";
    const isTerminalRecord = parsedEvent.payload_type === "run.terminal.completed" || eventPayload.kind === "run_terminal";
    if (isTerminalRecord) {
      if (eventPayload.terminal !== undefined && eventPayload.terminal !== "completed") {
        continue;
      }
      if (itemText) {
        terminalResult = itemText;
      }
    } else {
      const isDeltaRecord = parsedEvent.payload_type === "run.output.delta" || eventPayload.kind === "run_output_delta";
      if (isDeltaRecord) {
        concatenatedDeltas += itemText;
      }
    }
  }
  if (terminalResult) {
    return terminalResult;
  }
  return concatenatedDeltas.length > 0 ? concatenatedDeltas : null;
}
// Validates that candidate title conforms to 3-8 words rule and is not placeholder.
function validateWordBounds(candidateText: string | null): string | null {
  if (!candidateText || candidateText === PLACEHOLDER_TITLE) {
    return null;
  }
  const wordTokens = candidateText.split(/\s+/).filter(Boolean);
  return wordTokens.length >= 3 && wordTokens.length <= 8 ? candidateText : null;
}
// Cleans model output and enforces title constraints, falling back to prompt derivation.
export function sanitizeThreadTitle(rawResponse: string, promptFallback: string): string | null {
  let processedText = rawResponse.trim();
  if (processedText.startsWith("{")) {
    try {
      const parsedJson = JSON.parse(processedText);
      if (typeof parsedJson === "object" && parsedJson !== null && typeof parsedJson.title === "string") {
        processedText = parsedJson.title;
      }
    } catch {
      // keep raw string if json fails
    }
  }
  let strippedText = processedText.trim();
  if (/^title\s*:\s*/i.test(strippedText)) {
    strippedText = strippedText.replace(/^title\s*:\s*/i, "").trim();
  }
  strippedText = strippedText.replace(/^['"`]+/, "").replace(/['"`]+$/, "").trim();
  const evaluatedCandidate = validateWordBounds(deriveTitle(strippedText));
  if (evaluatedCandidate !== null) {
    return evaluatedCandidate;
  }
  return validateWordBounds(deriveTitle(promptFallback));
}
