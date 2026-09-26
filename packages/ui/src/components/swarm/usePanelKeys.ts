import { useCallback, type KeyboardEvent } from "react";
import { isTyping } from "../requests/Requests.js";

/**
 * The Swarm panel's keys (SPEC §11). The map is a pure function of the key and where the panel is, so the table is
 * testable without a DOM; the hook binds it to the panel's own key handler, so the keys only work while the panel
 * holds focus and never while a text field has it.
 */

export type PanelMode = "roster" | "inspector";

export type PanelKeyAction =
  | "next" | "previous"
  | "inspect" | "peek"
  | "next-issue" | "previous-issue"
  | "find" | "cycle-filter" | "timeline"
  | "collapse-phase" | "expand-phase"
  | "retry" | "skip" | "stop"
  | "tab-overview" | "tab-lifecycle" | "tab-result"
  | "back";

export interface PanelKeyInput {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** The event goes to an input, textarea or editable element. */
  typing?: boolean;
}

/** The action a key stands for in the panel, or null when the key is not the panel's. */
export function panelKeyAction(input: PanelKeyInput, mode: PanelMode): PanelKeyAction | null {
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  if (input.typing) return null;
  switch (input.key) {
    case "j": case "ArrowDown": return "next";
    case "k": case "ArrowUp": return "previous";
    case "Enter": return mode === "inspector" ? null : "inspect";
    case " ": case "Spacebar": return mode === "inspector" ? null : "peek";
    case "n": return "next-issue";
    case "N": return "previous-issue";
    case "/": return "find";
    case "f": return "cycle-filter";
    case "t": return "timeline";
    case "[": return "collapse-phase";
    case "]": return "expand-phase";
    case "r": return "retry";
    case "s": return "skip";
    case "x": return "stop";
    case "1": return mode === "inspector" ? "tab-overview" : null;
    case "2": return mode === "inspector" ? "tab-lifecycle" : null;
    case "3": return mode === "inspector" ? "tab-result" : null;
    case "Escape": case "Esc": return "back";
    default: return null;
  }
}

/**
 * A `onKeyDown` for the panel's root. `handle` returns true when it took the action, in which case the event stops
 * here; an untaken key bubbles as usual (the app's own shortcuts stay untouched either way, since they use modifiers).
 */
export function usePanelKeys(mode: PanelMode, handle: (action: PanelKeyAction, event: KeyboardEvent<HTMLElement>) => boolean): (event: KeyboardEvent<HTMLElement>) => void {
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const action = panelKeyAction(
        { key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, typing: isTyping(event.target) },
        mode,
      );
      if (action === null) return;
      if (handle(action, event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [mode, handle],
  );
}
