/**
 * Workflow launch and sub-agent execution reconciliation payload structures.
 */

export interface ReconciledPayload {
  agents_activity?: { agent?: string; duration_ms?: number; tool_calls?: number }[];
  final_summary?: { status?: string; summary?: string };
  latest_failure?: unknown;
  launch_admitted?: boolean;
  deferred_to_background?: boolean;
  call_id?: string;
}

export type Reconciled = ReconciledPayload;

/** Set of terminal states signifying abnormal workflow termination. */
export const TERMINAL_FAILURES = new Set(["failed", "rejected", "cancelled", "timedOut"]);

const RECONCILED_TAG_REGEX = /<workflow-launch-reconciled>([\s\S]*?)<\/workflow-launch-reconciled>/;

function parseJsonSafe(text: string): ReconciledPayload | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" ? (value as ReconciledPayload) : null;
  } catch {
    return null;
  }
}

/**
 * Extracts and parses a workflow reconciliation JSON payload from an item message string.
 * Supports payloads enclosed within <workflow-launch-reconciled> XML tags or raw JSON blocks.
 */
export function reconciled(message: string | undefined): ReconciledPayload | null {
  if (typeof message !== "string" || message.length === 0) {
    return null;
  }

  const match = RECONCILED_TAG_REGEX.exec(message);
  if (match?.[1]) {
    return parseJsonSafe(match[1]);
  }

  const trimmed = message.trim();
  if (trimmed.startsWith("{")) {
    return parseJsonSafe(trimmed);
  }

  return null;
}
