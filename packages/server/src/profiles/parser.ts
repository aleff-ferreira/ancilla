import type { LoginParseResult } from "./types.js";

/**
 * Parses stdout/stderr chunks from Muse login command, stripping ANSI sequences
 * and extracting the HTTPS device authorization URL and code.
 */
export function parseLoginOutput(chunk: string): LoginParseResult {
  if (typeof chunk !== "string") {
    return { url: null, code: null };
  }

  // 1. Strip ANSI escape sequences
  const stripped = chunk.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

  // 2. Find HTTPS URL (reject plain http)
  const urlMatch = stripped.match(/https:\/\/[^\s"'<>\\]+/i);
  if (!urlMatch) {
    return { url: null, code: null };
  }

  // 3. Strip trailing punctuation
  const cleanUrl = urlMatch[0].replace(/[).,;]+$/, "");

  // 4. Extract authorization code from URL query parameters or text
  let code: string | null = null;
  try {
    const parsed = new URL(cleanUrl);
    code = parsed.searchParams.get("code") || parsed.searchParams.get("user_code");
  } catch {
    // If URL parsing fails, continue to text matching
  }

  if (!code) {
    const codeMatch = stripped.match(/(?:code|user_code)[:=\s]+([A-Z0-9-]{4,16})/i);
    if (codeMatch) {
      code = codeMatch[1];
    }
  }

  return {
    url: cleanUrl,
    code: code || null,
  };
}
