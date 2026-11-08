/**
 * Loading the speech models ahead of a call. The first call after Ancilla starts would otherwise spend three to six
 * seconds loading them while the person waits for the first word; a pointer over the Talk button is warning enough. At most
 * once in a couple of minutes, only when the voice is installed, and the server lets the models go again after ten idle
 * minutes, so a hover that comes to nothing costs a little memory for a little while and nothing else.
 */

const WARM_EVERY_MS = 120_000;
let warmedAt = 0;

export interface WarmTarget {
  hasVoice: boolean;
  voice: (method: "POST", path: string) => Promise<unknown>;
}

/** Asks the server to load the models; says whether it asked. Never throws, and never waits for the answer. */
export function warmVoice(target: WarmTarget, available: boolean | null, now = Date.now()): boolean {
  if (available !== true || !target.hasVoice || now - warmedAt < WARM_EVERY_MS) return false;
  warmedAt = now;
  target.voice("POST", "/warm").catch(() => undefined);
  return true;
}

/** For the tests: forgets when the models were last warmed. */
export function forgetWarmth(): void {
  warmedAt = 0;
}
