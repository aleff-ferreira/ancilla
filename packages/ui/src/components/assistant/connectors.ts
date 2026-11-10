import type { AssistantConnectorActivity, AssistantConnectorView, AssistantWriteClass, AssistantWritePolicy } from "../../types.js";

/** What the Connectors page says, apart from how it looks: so that it can be held to what is true without drawing it. */

export type ConnectorTone = "plain" | "ok" | "warn" | "danger" | "accent";

/** The kinds of change, in the order the page lists them, with what each means in words for the person. */
export const WRITE_CLASSES: ReadonlyArray<{ id: AssistantWriteClass; label: string; hint: string }> = [
  { id: "reversible", label: "Small changes you can undo", hint: "for example creating a branch" },
  { id: "communicates", label: "Changes other people see", hint: "comments, issues, pull requests" },
  { id: "destructive", label: "Changes that cannot be taken back", hint: "merging, closing" },
];

/** Whether any kind of change is switched on: then the assistant may ask for one, and the person is asked each time. */
export function mayChange(policy: AssistantWritePolicy): boolean {
  return WRITE_CLASSES.some((c) => policy[c.id] !== "off");
}

/** What a connector's chip says, and how it looks. */
export function statusOf(view: AssistantConnectorView): { label: string; tone: ConnectorTone } {
  if (!view.connected) return { label: "Not connected", tone: "plain" };
  if (view.mode === "off") return { label: "Connected, switched off", tone: "warn" };
  if (view.test && !view.test.ok) return { label: "Connected, last check failed", tone: "danger" };
  return { label: mayChange(view.policy) ? "Connected, asks before it changes things" : "Connected, read only", tone: "ok" };
}

/** Whether a typed token can be sent at all: the shape the server takes (no spaces, 8 to 2000 characters). */
export function tokenLooksUsable(raw: string): boolean {
  return /^[!-~]{8,2000}$/.test(raw.trim());
}

/** What the last test found, as a sentence for the page: what the assistant is given, and what it is not. */
export function reachNote(view: AssistantConnectorView): string | null {
  const test = view.test;
  if (!test || !test.ok) return null;
  const reads = test.offered.filter((t) => t.class === "read").length;
  const changes = test.offered.length - reads;
  const given = changes > 0 ? `${reads} read tool${reads === 1 ? "" : "s"} and ${changes} that ask${changes === 1 ? "s" : ""} you before ${changes === 1 ? "it changes" : "they change"} something` : `${reads} read-only tool${reads === 1 ? "" : "s"}`;
  const more = test.hidden > 0 ? ` ${test.hidden} more that the server has ${test.hidden === 1 ? "is" : "are"} not offered, because ${test.hidden === 1 ? "it can" : "they can"} change things or ${test.hidden === 1 ? "is" : "are"} not on Ancilla's list.` : "";
  const gone = test.missing.length > 0 ? ` ${test.missing.length} on Ancilla's list ${test.missing.length === 1 ? "was" : "were"} not found on the server, so ${test.missing.length === 1 ? "it is" : "they are"} not offered either.` : "";
  return `The assistant is given ${given}.${more}${gone}`;
}

const SETTING_WORDS: Record<string, string> = { off: "switched off", ask: "asks you first", always: "allowed without asking" };

/** The activity of one change, in words: the step it reached, and a short fingerprint of its arguments so it can be told from another. */
function writeLine(entry: AssistantConnectorActivity, who: string, tool: string): string {
  const print = entry.hash ? ` (fingerprint ${entry.hash.slice(0, 8)})` : "";
  switch (entry.phase) {
    case "held":
      return `${who}: ${tool} waits for your answer${print}`;
    case "approved":
      return `${who}: you approved ${tool}${entry.note && /standing/.test(entry.note) ? " under your standing rule" : ""}${print}`;
    case "executed":
      return entry.ok ? `${who}: ${tool} was done${print}` : `${who}: ${tool} was approved but did not work${print}`;
    case "expired":
      return `${who}: ${tool} was not done, because nobody answered in time${print}`;
    case "proposed":
      return `${who}: ${tool} was kept for you to decide, because the task was not started by you${print}`;
    default:
      return `${who}: ${tool} was not done${entry.note ? `: ${entry.note}` : ""}${print}`;
  }
}

/** One line of the activity list, in words. */
export function activityLine(entry: AssistantConnectorActivity, nameOf: (id: string) => string): string {
  const who = nameOf(entry.connector);
  const tool = entry.tool ?? "a tool";
  switch (entry.kind) {
    case "call":
      if (entry.ok) return `${who}: read with ${tool}`;
      if (entry.note === "refused: switched off") return `${who}: ${tool} was refused, because that kind of change is switched off`;
      return entry.note?.startsWith("refused") ? `${who}: ${tool} was refused, because it is not on the list of tools it may use` : `${who}: ${tool} did not work`;
    case "write":
      return writeLine(entry, who, tool);
    case "connect":
      return entry.ok ? `${who}: connected` : `${who}: connecting did not work`;
    case "test":
      return entry.ok ? `${who}: checked, and it works` : `${who}: the check did not work`;
    case "mode":
      return entry.note === "mode off" ? `${who}: switched off` : `${who}: switched on`;
    case "policy": {
      const said = (entry.note ?? "").split(", ").map((part) => {
        const [cls, value] = part.split(" ");
        const label = WRITE_CLASSES.find((c) => c.id === cls)?.label.toLowerCase();
        return label && value ? `${label}: ${SETTING_WORDS[value] ?? value}` : part;
      });
      return `${who}: ${said.join("; ")}`;
    }
    case "disconnect":
      return `${who}: disconnected`;
  }
}
