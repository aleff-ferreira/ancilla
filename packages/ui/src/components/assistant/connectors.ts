import type { AssistantConnectorActivity, AssistantConnectorView } from "../../types.js";

/** What the Connectors page says, apart from how it looks: so that it can be held to what is true without drawing it. */

export type ConnectorTone = "plain" | "ok" | "warn" | "danger" | "accent";

/** What a connector's chip says, and how it looks. */
export function statusOf(view: AssistantConnectorView): { label: string; tone: ConnectorTone } {
  if (!view.connected) return { label: "Not connected", tone: "plain" };
  if (view.mode === "off") return { label: "Connected, switched off", tone: "warn" };
  if (view.test && !view.test.ok) return { label: "Connected, last check failed", tone: "danger" };
  return { label: "Connected, read only", tone: "ok" };
}

/** Whether a typed token can be sent at all: the shape the server takes (no spaces, 8 to 2000 characters). */
export function tokenLooksUsable(raw: string): boolean {
  return /^[!-~]{8,2000}$/.test(raw.trim());
}

/** What the last test found, as a sentence for the page: what the assistant is given, and what it is not. */
export function reachNote(view: AssistantConnectorView): string | null {
  const test = view.test;
  if (!test || !test.ok) return null;
  const offered = test.offered.length;
  const more = test.hidden > 0 ? ` ${test.hidden} more that the server has ${test.hidden === 1 ? "is" : "are"} not offered, because ${test.hidden === 1 ? "it can" : "they can"} change things or ${test.hidden === 1 ? "is" : "are"} not on Ancilla's list.` : "";
  const gone = test.missing.length > 0 ? ` ${test.missing.length} on Ancilla's list ${test.missing.length === 1 ? "was" : "were"} not found on the server, so ${test.missing.length === 1 ? "it is" : "they are"} not offered either.` : "";
  return `The assistant is given ${offered} read-only tool${offered === 1 ? "" : "s"}.${more}${gone}`;
}

/** One line of the activity list, in words. */
export function activityLine(entry: AssistantConnectorActivity, nameOf: (id: string) => string): string {
  const who = nameOf(entry.connector);
  const tool = entry.tool ?? "a tool";
  switch (entry.kind) {
    case "call":
      if (entry.ok) return `${who}: read with ${tool}`;
      return entry.note?.startsWith("refused") ? `${who}: ${tool} was refused, because it is not on the list of tools it may use` : `${who}: ${tool} did not work`;
    case "connect":
      return entry.ok ? `${who}: connected` : `${who}: connecting did not work`;
    case "test":
      return entry.ok ? `${who}: checked, and it works` : `${who}: the check did not work`;
    case "mode":
      return entry.note === "mode off" ? `${who}: switched off` : `${who}: switched on for reading`;
    case "disconnect":
      return `${who}: disconnected`;
  }
}
