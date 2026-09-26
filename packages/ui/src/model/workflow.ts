/**
 * What a workflow run tells us about itself. Muse reports the run as one item that is revised as it
 * goes (one real run produced 72 revisions), carrying its children, and a reconciliation payload
 * wrapped in a tag inside `message`. Since Muse 1.4.0 a child carries its tokens on one revision,
 * which the fold latches; nothing else about cost is on the wire, so nothing here invents it.
 */

interface Reconciled {
  agents_activity?: { agent?: string; duration_ms?: number; tool_calls?: number }[];
  final_summary?: { status?: string; summary?: string };
  latest_failure?: unknown;
  launch_admitted?: boolean;
  deferred_to_background?: boolean;
  call_id?: string;
}

const WRAPPER = /<workflow-launch-reconciled>([\s\S]*?)<\/workflow-launch-reconciled>/;

/** Terminal statuses that mean the run did not succeed, matching how the transcript reads items. */
export const TERMINAL_FAILURES = new Set(["failed", "rejected", "cancelled", "timedOut"]);

/** The reconciliation payload Muse tucks inside `message`, or null when there is not one yet. */
export function reconciled(message: string | undefined): Reconciled | null {
  if (!message) {
    return null;
  }
  const inner = WRAPPER.exec(message)?.[1] ?? (message.trim().startsWith("{") ? message : null);
  if (!inner) {
    return null;
  }
  try {
    const parsed = JSON.parse(inner) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Reconciled) : null;
  } catch {
    return null;
  }
}
