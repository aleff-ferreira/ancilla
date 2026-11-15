import { useCallback, type KeyboardEvent } from "react";
import { isTyping } from "../requests/Requests.js";

/**
 * Keyboard shortcuts controller for the Crew panel across Roster and Inspector modes (SPEC §11).
 */
export type PanelMode = "roster" | "inspector";

export type PanelKeyAction = "next" | "previous" | "inspect" | "peek" | "next-issue" | "previous-issue" | "find" | "cycle-filter" | "timeline" | "collapse-phase" | "expand-phase" | "retry" | "skip" | "stop" | "tab-overview" | "tab-lifecycle" | "tab-result" | "back";

export interface PanelKeyInput {
  readonly key: string;
  readonly typing?: boolean;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
}

const GENERAL_NAVIGATION_MAP: Readonly<Record<string, PanelKeyAction>> = Object.freeze({
  j: "next",
  ArrowDown: "next",
  k: "previous",
  ArrowUp: "previous",
  n: "next-issue",
  N: "previous-issue",
  "/": "find",
  f: "cycle-filter",
  t: "timeline",
  "[": "collapse-phase",
  "]": "expand-phase",
  r: "retry",
  s: "skip",
  x: "stop",
  Escape: "back",
  Esc: "back",
});

const INSPECTOR_NUMERIC_TABS: Readonly<Record<string, PanelKeyAction>> = Object.freeze({
  "1": "tab-overview",
  "2": "tab-lifecycle",
  "3": "tab-result",
});

export function panelKeyAction(input: PanelKeyInput, currentMode: PanelMode): PanelKeyAction | null {
  const hasAppModifier = Boolean(input.ctrlKey || input.metaKey || input.altKey);
  if (hasAppModifier || input.typing) {
    return null;
  }

  const pressed = input.key;
  if (currentMode === "inspector") {
    const tabTarget = INSPECTOR_NUMERIC_TABS[pressed];
    if (tabTarget !== undefined) return tabTarget;
    if (pressed === "Enter" || pressed === " " || pressed === "Spacebar") {
      return null;
    }
  } else {
    if (pressed === "Enter") return "inspect";
    if (pressed === " " || pressed === "Spacebar") return "peek";
    if (pressed === "1" || pressed === "2" || pressed === "3") {
      return null;
    }
  }

  return GENERAL_NAVIGATION_MAP[pressed] ?? null;
}

export function usePanelKeys(
  mode: PanelMode,
  dispatcher: (action: PanelKeyAction, event: KeyboardEvent<HTMLElement>) => boolean,
): (event: KeyboardEvent<HTMLElement>) => void {
  return useCallback(
    (keyEvent: KeyboardEvent<HTMLElement>) => {
      const isInputActive = isTyping(keyEvent.target);
      const resolved = panelKeyAction(
        {
          key: keyEvent.key,
          typing: isInputActive,
          shiftKey: keyEvent.shiftKey,
          ctrlKey: keyEvent.ctrlKey,
          altKey: keyEvent.altKey,
          metaKey: keyEvent.metaKey,
        },
        mode,
      );

      if (resolved === null) {
        return;
      }

      const consumed = dispatcher(resolved, keyEvent);
      if (consumed) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
      }
    },
    [mode, dispatcher],
  );
}
