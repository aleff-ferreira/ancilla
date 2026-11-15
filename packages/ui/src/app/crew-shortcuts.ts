/**
 * Global keyboard shortcuts and dynamic window title generation for Ancilla.
 * Maps application-wide chords to drawer/panel navigation targets.
 */

export interface ShortcutKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target?: EventTarget | null;
}

export type CrewShortcut = "activity" | "crew" | "browser";

interface EditableTargetDescriptor {
  tagName?: unknown;
  isContentEditable?: unknown;
}

function hasEditableFocus(target: EventTarget | null | undefined): boolean {
  if (!target) return false;
  const descriptor = target as EditableTargetDescriptor;
  if (descriptor.isContentEditable === true) {
    return true;
  }
  if (typeof descriptor.tagName === "string") {
    const uppercaseTag = descriptor.tagName.toUpperCase();
    return uppercaseTag === "INPUT" || uppercaseTag === "TEXTAREA";
  }
  return false;
}

const ACTION_MAP: Readonly<Record<string, CrewShortcut>> = Object.freeze({
  a: "activity",
  m: "crew",
  b: "browser",
});

/**
 * Evaluates whether an incoming keyboard event triggers an Ancilla navigation shortcut.
 * Ensures the target element is non-editable and the proper platform modifiers are held.
 */
export function crewShortcut(event: ShortcutKey, isMac: boolean): CrewShortcut | null {
  const primaryModifier = isMac ? event.metaKey : event.ctrlKey;
  const isSatisfied = primaryModifier && event.shiftKey && !event.altKey;
  if (!isSatisfied || hasEditableFocus(event.target)) {
    return null;
  }
  const normalizedKey = event.key.toLowerCase();
  return ACTION_MAP[normalizedKey] ?? null;
}

/**
 * Builds the application window header string reflecting pending request counters
 * and the active session thread subject.
 */
export function windowTitle(count: number, thread: string | null): string {
  const activeTopic = thread?.trim();
  const brandSuffix = activeTopic ? `${activeTopic} — Ancilla` : "Ancilla";
  if (count > 0) {
    return `(${count}) ${brandSuffix}`;
  }
  return brandSuffix;
}
