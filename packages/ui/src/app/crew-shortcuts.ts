/**
 * The Crew chords and the window's name, kept apart from the app shell so they can be checked without a browser:
 * `Ctrl/Cmd+Shift+A` opens the Activity drawer, `Ctrl/Cmd+Shift+M` the Crew panel. Neither fires from a text
 * field, where a chord may belong to the field.
 */

export interface ShortcutKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target?: EventTarget | null;
}

export type CrewShortcut = "activity" | "crew";

function typingIn(target: EventTarget | null | undefined): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true));
}

/** The Crew surface a key press asks for, or null when it asks for none. */
export function crewShortcut(event: ShortcutKey, mac: boolean): CrewShortcut | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (!mod || !event.shiftKey || event.altKey || typingIn(event.target)) {
    return null;
  }
  switch (event.key.toLowerCase()) {
    case "a":
      return "activity";
    case "m":
      return "crew";
    default:
      return null;
  }
}

/** `(2) Design the sync engine — Ancilla`: the requests waiting anywhere, the open thread, the app. */
export function windowTitle(count: number, thread: string | null): string {
  const name = thread && thread.trim() ? `${thread.trim()} — Ancilla` : "Ancilla";
  return count > 0 ? `(${count}) ${name}` : name;
}
