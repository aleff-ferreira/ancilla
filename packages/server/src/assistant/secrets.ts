/**
 * What the assistant must never keep. Distilled memory is read back into every prompt and shown on a page, so a
 * password or a key that was typed into a message once would be copied everywhere. This is a refusal list, not a
 * scanner: it recognises the shapes credentials and personal identifiers have, and says which kind it saw so the
 * user can be told why a statement was not saved. It never returns the value itself.
 */

const NOT_A_PASSWORD = new Set(["required", "stored", "set", "enabled", "disabled", "empty", "hashed", "salted", "encrypted", "rotated", "managed", "optional", "none", "unset", "missing", "expired", "valid", "invalid", "the", "a", "an", "in", "on", "not", "never", "always", "must", "should", "will", "is", "are", "to", "for", "of", "and", "or", "kept", "saved", "shared", "safe", "secret", "private", "long", "short", "strong", "weak"]);

interface Shape {
  kind: string;
  test: RegExp;
}

const SHAPES: Shape[] = [
  { kind: "private key", test: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "cloud access key", test: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "access token", test: /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { kind: "api key", test: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/ },
  { kind: "chat token", test: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "api key", test: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { kind: "payment key", test: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { kind: "signed token", test: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { kind: "bearer token", test: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { kind: "connection string", test: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@[^\s/]+/i },
  { kind: "national id", test: /\b\d{3}-\d{2}-\d{4}\b/ },
  { kind: "national id", test: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/ },
  { kind: "company id", test: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/ },
];

/** "the password is hunter2", "password: hunter2", "senha = hunter2". */
const PASSWORD_SAID = /\b(?:password|passwd|pwd|passphrase|senha)\b\s*(?:is|was|=|:|->)\s*["'`]?([^\s"'`,;]{4,})/i;
/** "my password hunter2": no verb, so only a value that looks like a password counts. */
const PASSWORD_BARE = /\b(?:password|passwd|pwd|passphrase|senha)\b\s+["'`]?([^\s"'`,;]{6,})/i;
const PIN_SAID = /\b(?:pin|pin code)\b\s*(?:is|=|:)\s*(\d{4,8})\b/i;
const KEY_WORDS = /\b(?:api[ _-]?key|secret[ _-]?key|access[ _-]?key|private[ _-]?key|ssh[ _-]?key|auth(?:orization)?[ _-]?token|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|secret|token|credentials?)\b\s*(?:is|was|=|:|->)\s*["'`]?([^\s"'`,;]{8,})/i;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function ibanOk(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = ch >= "A" ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48;
    rest = Number(`${rest}${v}`) % 97;
  }
  return rest === 1;
}

function looksLikeKeyValue(value: string): boolean {
  return value.length >= 12 && /[A-Za-z]/.test(value) && /[0-9_\-+/=]/.test(value) && entropy(value) >= 3;
}

/** The kind of credential or personal identifier a text contains, or null. The value is never returned. */
export function looksSecret(text: string): string | null {
  for (const shape of SHAPES) if (shape.test.test(text)) return shape.kind;

  const said = PASSWORD_SAID.exec(text);
  if (said) {
    const value = (said[1] ?? "").replace(/[.!?]+$/, "");
    // "the password is required" is a sentence about passwords; "the password is hunter2" is a password.
    if (value.length >= 4 && !NOT_A_PASSWORD.has(value.toLowerCase()) && (/[0-9]|[^A-Za-z]/.test(value) || value.length >= 8)) return "password";
  }
  const bare = PASSWORD_BARE.exec(text);
  if (bare) {
    const value = (bare[1] ?? "").replace(/[.!?]+$/, "");
    if (!NOT_A_PASSWORD.has(value.toLowerCase()) && /[A-Za-z]/.test(value) && /[0-9]/.test(value)) return "password";
  }
  if (PIN_SAID.test(text)) return "pin";
  const key = KEY_WORDS.exec(text);
  if (key && looksLikeKeyValue((key[1] ?? "").replace(/[.!?]+$/, ""))) return "secret key";

  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "card number";
  }
  for (const m of text.matchAll(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{2,6}){3,8}\b/g)) if (ibanOk(m[0])) return "bank account";

  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{28,}/g)) {
    const value = m[0];
    // A commit or file hash is an identifier worth keeping; a long mixed string with no pattern to it is a secret.
    if (/^[0-9a-f]{32,64}$/i.test(value) && (value.length === 40 || value.length === 64 || value.length === 32)) continue;
    if (/^[A-Za-z]+$/.test(value) || /^[0-9]+$/.test(value)) continue;
    if (/\//.test(value) && !/[+=]/.test(value) && /^[\w./-]+$/.test(value)) continue;
    if (entropy(value) >= 4) return "secret string";
  }
  return null;
}
