/**
 * Diagnosis and remediation strategies for stuck thread error states.
 */

export type StuckKind = "image" | "reasoning";
export type StuckRemedy = "compact" | "fresh" | "none";

export interface StuckThread {
  kind: StuckKind;
  remedy: StuckRemedy;
  message: string;
}

export interface StuckThreadOptions {
  ownImages?: boolean;
}

interface StuckDiagnosticRule {
  readonly kind: StuckKind;
  readonly remedy: StuckRemedy;
  readonly pattern: RegExp;
  readonly description: string;
}

const DIAGNOSTIC_RULES: readonly StuckDiagnosticRule[] = [
  {
    kind: "image",
    remedy: "compact",
    pattern: /invalid image data at input\[|payload could not be decoded/i,
    description:
      "An earlier attachment in this conversation cannot be decoded by the active model. Because full history is replayed on every request, subsequent turns will continue failing. Compacting summarizes prior context and omits unreadable binary payloads.",
  },
  {
    kind: "reasoning",
    remedy: "fresh",
    pattern: /provider-private history is incompatible|reasoning replay .* has no provider attribution/i,
    description:
      "Opaque reasoning state saved by a previous provider cannot be replayed after switching routes, and compaction preserves recent turns intact. Start a new thread so turns run without legacy reasoning blocks.",
  },
];

const OWN_IMAGE_REMEDY_TEXT =
  "The active model rejected an image attachment. If you included an image sent with this message, resend it as a standard PNG or JPEG; if that works, an older image earlier in the conversation is corrupted and compacting removes it from future requests.";

/**
 * Inspects a provider error message to determine if a thread is irreversibly stuck.
 * Returns targeted recovery actions (such as compaction or starting a fresh thread).
 */
export function stuckThread(
  message: string | null | undefined,
  options: StuckThreadOptions = {},
): StuckThread | null {
  if (typeof message !== "string" || message.length === 0) {
    return null;
  }

  const matchedRule = DIAGNOSTIC_RULES.find((rule) => rule.pattern.test(message));
  if (!matchedRule) {
    return null;
  }

  if (matchedRule.kind === "image" && options.ownImages === true) {
    return {
      kind: "image",
      remedy: "none",
      message: OWN_IMAGE_REMEDY_TEXT,
    };
  }

  return {
    kind: matchedRule.kind,
    remedy: matchedRule.remedy,
    message: matchedRule.description,
  };
}
