// Unit tests for thread titling heuristics, prompt construction, and output sanitization
import { describe as suite, it as testCase } from "node:test";
import strictAssert from "node:assert/strict";
import {
  buildThreadTitlePrompt,
  deriveTitle,
  limitTitleText,
  parseExecTitle,
  sanitizeThreadTitle,
  TITLE_PROMPT_MAX_CHARS,
} from "../src/threadTitles.js";
suite("deriveTitle", () => {
  testCase("extracts title from the first non-empty line", () => {
    strictAssert.equal(deriveTitle("  \n\n  Implement user registration  \nNext line"), "Implement user registration");
    strictAssert.equal(deriveTitle("# Refactor authentication service"), "Refactor authentication service");
    strictAssert.equal(deriveTitle("> Fix broken test cases"), "Fix broken test cases");
    strictAssert.equal(deriveTitle("- Update dependencies"), "Update dependencies");
  });
  testCase("returns null for empty or whitespace-only inputs", () => {
    strictAssert.equal(deriveTitle(""), null);
    strictAssert.equal(deriveTitle("   \n\t  \n  "), null);
    strictAssert.equal(deriveTitle("```\n```"), null);
  });
  testCase("strips code fences and ignores empty fenced blocks", () => {
    strictAssert.equal(deriveTitle("```typescript\nfunction greet() {}\n```"), "function greet() {}");
    strictAssert.equal(deriveTitle("```json\n\n```\nActual user text"), "Actual user text");
  });
  testCase("truncates lines exceeding 72 characters with ellipsis on word boundary", () => {
    const verbosePrompt = "This is an extraordinarily descriptive task prompt written to exceed the standard line length limit for testing boundary truncation";
    const shortened = deriveTitle(verbosePrompt);
    strictAssert.ok(shortened !== null);
    strictAssert.ok(shortened.length <= 75);
    strictAssert.ok(shortened.endsWith("..."));
  });
});
suite("limitTitleText", () => {
  testCase("returns unmodified text when below character budget", () => {
    strictAssert.equal(limitTitleText("Fix login", 100), "Fix login");
    strictAssert.equal(limitTitleText("Short prompt", 12), "Short prompt");
  });
  testCase("partitions text into head and tail around truncation notice when exceeding budget", () => {
    const longString = `${"a".repeat(100)}${"b".repeat(100)}`;
    const constrainedText = limitTitleText(longString, 100);
    strictAssert.equal(constrainedText.length, 100);
    strictAssert.match(constrainedText, /a+\n\[Content truncated\]\nb+/);
  });
  testCase("returns empty string if budget cannot accommodate truncation marker", () => {
    strictAssert.equal(limitTitleText("Fix login with longer text that exceeds budget", 3), "");
    strictAssert.equal(limitTitleText("Fix login with longer text that exceeds budget", 21), "");
  });
});
suite("buildThreadTitlePrompt", () => {
  testCase("structures prompt with system guidelines leading user text", () => {
    const promptString = buildThreadTitlePrompt("Fix login redirect");
    strictAssert.match(promptString, /^Generate a title/);
    strictAssert.match(promptString, /Reply with ONLY the title text/);
    strictAssert.match(promptString, /User message:\nFix login redirect$/);
  });
  testCase("enforces maximum prompt budget on oversized messages", () => {
    const oversizedInput = "x".repeat(TITLE_PROMPT_MAX_CHARS + 500);
    const generatedPrompt = buildThreadTitlePrompt(oversizedInput);
    strictAssert.match(generatedPrompt, /\[Content truncated\]/);
    strictAssert.ok(generatedPrompt.length < TITLE_PROMPT_MAX_CHARS + 2000);
  });
  testCase("prevents leading flags from commandeering argv position", () => {
    const dangerousInput = "--model evil\nFix login";
    const formattedPrompt = buildThreadTitlePrompt(dangerousInput);
    strictAssert.match(formattedPrompt, /^Generate a title/);
    strictAssert.match(formattedPrompt, /--model evil/);
  });
});
suite("parseExecTitle", () => {
  const formatTerminal = (titleText: string, statusKind = "completed") =>
    JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: statusKind, text: titleText } });
  const formatDelta = (chunkText: string) =>
    JSON.stringify({ payload_type: "run.output.delta", payload: { kind: "run_output_delta", text: chunkText } });
  testCase("extracts terminal completion text from execution stream", () => {
    const eventStream = [
      "muse: workspace root: /tmp (cwd default)",
      JSON.stringify({ payload_type: "run.lifecycle.started", payload: { kind: "run_started" } }),
      formatDelta("Fix log"),
      formatDelta("in redirect"),
      formatTerminal("Fix login redirect"),
      "plain terminal diagnostic output",
    ].join("\n");
    strictAssert.equal(parseExecTitle(eventStream), "Fix login redirect");
  });
  testCase("takes the latest terminal record when multiple are issued", () => {
    const eventStream = [formatTerminal("First attempt"), formatTerminal("Second attempt")].join("\n");
    strictAssert.equal(parseExecTitle(eventStream), "Second attempt");
  });
  testCase("aggregates output deltas if no terminal event was emitted", () => {
    const eventStream = [formatDelta("Fix log"), formatDelta("in redirect")].join("\n");
    strictAssert.equal(parseExecTitle(eventStream), "Fix login redirect");
  });
  testCase("disregards non-completed terminal records and relies on deltas", () => {
    const eventStream = [formatTerminal("aborted", "failed"), formatDelta("Fix login")].join("\n");
    strictAssert.equal(parseExecTitle(eventStream), "Fix login");
  });
  testCase("returns null when no text is conveyed in stdout stream", () => {
    strictAssert.equal(parseExecTitle(""), null);
    strictAssert.equal(parseExecTitle("random error\n{malformed json"), null);
    strictAssert.equal(parseExecTitle(JSON.stringify({ payload_type: "run.lifecycle.started", payload: {} })), null);
  });
});
suite("sanitizeThreadTitle", () => {
  testCase("accepts conformant 3-8 word titles without modification", () => {
    strictAssert.equal(sanitizeThreadTitle("Fix login redirect", "fallback"), "Fix login redirect");
  });
  testCase("removes outer quotes, title labels, and JSON structure", () => {
    strictAssert.equal(sanitizeThreadTitle('"Fix login redirect"', "fallback"), "Fix login redirect");
    strictAssert.equal(sanitizeThreadTitle("Title: Fix login redirect", "fallback"), "Fix login redirect");
    strictAssert.equal(sanitizeThreadTitle('{"title": "Fix login redirect"}', "fallback"), "Fix login redirect");
  });
  testCase("discards candidates outside 3-8 words in favor of prompt fallback", () => {
    strictAssert.equal(
      sanitizeThreadTitle("Fix login", "Fix the broken login redirect flow"),
      "Fix the broken login redirect flow",
    );
    const oversizedTitle = "Refactor the session manager so that queries never mint command ids and paging works reliably for long threads";
    strictAssert.equal(sanitizeThreadTitle(oversizedTitle, "Implement dark theme support"), "Implement dark theme support");
  });
  testCase("uses prompt fallback when candidate is empty or placeholder title", () => {
    strictAssert.equal(sanitizeThreadTitle("", "Fix login redirect"), "Fix login redirect");
    strictAssert.equal(sanitizeThreadTitle("New thread", "Fix login redirect"), "Fix login redirect");
    strictAssert.equal(sanitizeThreadTitle("   ", "Fix login redirect"), "Fix login redirect");
  });
  testCase("returns null when neither candidate nor fallback produces valid title", () => {
    strictAssert.equal(sanitizeThreadTitle("", "   "), null);
    strictAssert.equal(sanitizeThreadTitle("New thread", "New thread"), null);
    strictAssert.equal(sanitizeThreadTitle("Fix login", "Do it"), null);
  });
});
