const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CURSOR_FORWARD_RE = new RegExp(`${ESC}\\[(\\d*)C`, "g");
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export interface ParsedProviderLoginOutput {
  url: string | null;
  code: string | null;
  needsCodeInput: boolean;
  /** True when whitespace or a newline follows the matched URL, proving the URL chunk was not split mid-stream. */
  urlComplete: boolean;
}

export function stripTerminalAnsi(raw: string): string {
  return raw
    .replace(CURSOR_FORWARD_RE, " ")
    .replace(OSC_RE, "")
    .replace(CSI_RE, "");
}

function isValidDeviceCode(candidate: string | null | undefined): candidate is string {
  if (!candidate) return false;
  const trimmed = candidate.trim();
  if (!trimmed || /^(?:true|false|null|undefined|code)$/i.test(trimmed)) {
    return false;
  }
  return /^[A-Z0-9]{3,12}(?:-[A-Z0-9]{3,12})+$/i.test(trimmed) || /^[A-Z0-9]{6,12}$/i.test(trimmed);
}

/**
 * Parses stdout/stderr from CLI sign-in commands (`claude auth login`, `codex login`, `copilot login`, etc.).
 * Preserves full OAuth query strings (`&client_id=...&state=...`), ignores `?code=true` / `response_type=code`,
 * extracts genuine device codes (`ABCD-1234`), and detects interactive paste-code prompts.
 */
export function parseProviderLoginOutput(raw: string): ParsedProviderLoginOutput {
  const cleaned = stripTerminalAnsi(raw);
  const urlRegex = /https:\/\/[^\s"'<>)\]`]+/gi;
  const match = urlRegex.exec(cleaned);

  let url: string | null = null;
  let urlComplete = false;
  if (match && match[0]) {
    const rawMatched = match[0];
    const afterIdx = match.index + rawMatched.length;
    urlComplete = afterIdx < cleaned.length && /\s/.test(cleaned[afterIdx] ?? "");
    url = rawMatched.replace(/[.,;:!?]+$/, "");
  }

  let code: string | null = null;
  if (url) {
    try {
      const parsedUrl = new URL(url);
      const userCode = parsedUrl.searchParams.get("user_code");
      if (isValidDeviceCode(userCode)) {
        code = userCode.trim();
      }
    } catch {
      /* ignore malformed partial URL */
    }
  }

  const withoutUrls = cleaned.replace(/https?:\/\/\S+/gi, " ");
  if (!code) {
    const deviceCodePatterns = [
      /(?:one-time|device|verification|user)\s+code(?:\s+is)?(?:\s*\([^)\n]{1,60}\))?\s*[:\-]?\s*([A-Z0-9]{3,8}-[A-Z0-9]{3,8})\b/i,
      /(?:enter|copy|use)\s+(?:this\s+|the\s+|your\s+)?(?:one-time\s+)?code(?:\s*\([^)\n]{1,60}\))?\s*[:\-]?\s*([A-Z0-9]{3,8}-[A-Z0-9]{3,8})\b/i,
    ];
    for (const pattern of deviceCodePatterns) {
      const found = pattern.exec(withoutUrls);
      if (found?.[1] && isValidDeviceCode(found[1])) {
        code = found[1];
        break;
      }
    }
  }

  let callbackNeedsCode = false;
  if (url) {
    const lowerUrl = decodeURIComponentSafe(url).toLowerCase();
    callbackNeedsCode =
      lowerUrl.includes("platform.claude.com/oauth/code/callback") ||
      lowerUrl.includes("console.anthropic.com/oauth/code/callback");
  }

  const promptNeedsCode =
    /paste\s+(?:the\s+)?code\s+here|enter\s+(?:the\s+)?(?:authorization|auth|login)\s+code|paste\s+(?:the\s+)?(?:authorization|auth)\s+code|authorization\s+code\s*[:>]/i.test(
      withoutUrls,
    );

  return {
    url,
    code,
    needsCodeInput: callbackNeedsCode || promptNeedsCode,
    urlComplete,
  };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function extractLoginFailureMessage(raw: string): string | null {
  const cleaned = stripTerminalAnsi(raw).replace(/\r/g, "");
  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^paste\s+code\s+here/i.test(line) && !/^if\s+(?:the\s+|your\s+)?browser/i.test(line));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (/(?:error|failed|invalid|expired|denied|unauthorized|unable\s+to)/i.test(line)) {
      return line.slice(0, 240);
    }
  }
  return null;
}
