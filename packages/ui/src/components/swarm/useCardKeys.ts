import { useCallback, type KeyboardEvent, type RefObject } from "react";
import { isTyping } from "../requests/Requests.js";

/**
 * The Swarm card's keyboard map (SPEC §11): a roving focus over the line or head, the rail's segments, the
 * attention rows, the open phase's rows and the task rows. Resolving a key into an intent is a pure function so
 * the map is testable without a DOM; applying it moves focus inside the card.
 */

export type FocusKind = "line" | "head" | "seg" | "row";

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export interface FocusInfo {
  kind: FocusKind | null;
  /** The focused row's agent state and kind, for `r`, `s` and `x`. */
  state?: string | null;
  agentKind?: string | null;
}

export type CardIntent =
  | { type: "escape" }
  | { type: "toggle" }
  | { type: "openPhase" }
  | { type: "inspect" }
  | { type: "peek" }
  | { type: "move"; delta: 1 | -1 }
  | { type: "segment"; delta: 1 | -1 }
  | { type: "attention"; delta: 1 | -1 }
  | { type: "retry" }
  | { type: "skip" }
  | { type: "stop" }
  | { type: "stopRun" };

/** The intent a key carries on the focused element, or null when the card leaves the key alone. */
export function resolveCardKey(event: KeyLike, focus: FocusInfo): CardIntent | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const { key } = event;
  if (key === "Escape") return { type: "escape" };
  if (focus.kind === null) return null;
  if (key === "Enter" || key === " ") {
    if (focus.kind === "line" || focus.kind === "head") return { type: "toggle" };
    if (focus.kind === "seg") return { type: "openPhase" };
    return key === "Enter" ? { type: "inspect" } : { type: "peek" };
  }
  if (key === "ArrowDown" || key === "j") return { type: "move", delta: 1 };
  if (key === "ArrowUp" || key === "k") return { type: "move", delta: -1 };
  if (key === "ArrowRight" && focus.kind === "seg") return { type: "segment", delta: 1 };
  if (key === "ArrowLeft" && focus.kind === "seg") return { type: "segment", delta: -1 };
  if (key === "n" || key === "N") return { type: "attention", delta: event.shiftKey || key === "N" ? -1 : 1 };
  if (focus.kind === "row") {
    if (key === "r" && focus.state === "failed") return { type: "retry" };
    if (key === "s" && focus.agentKind === "workflow" && focus.state !== "planned") return { type: "skip" };
    if (key === "x") return { type: "stop" };
  }
  if ((focus.kind === "head" || focus.kind === "line") && key === "x") return { type: "stopRun" };
  return null;
}

export interface CardKeyHandlers {
  /** Esc: closes the peek when one is open (true), else collapses the card. */
  escape: () => void;
  toggle: () => void;
  openPhase: (name: string) => void;
  inspect: (id: string) => void;
  peek: (id: string) => void;
  retry: (id: string) => void;
  skip: (id: string) => void;
  stop: (id: string) => void;
  stopRun: () => void;
}

const FOCUSABLE = "[data-swarm-focus]";

function focusOf(root: HTMLElement, target: EventTarget | null): { element: HTMLElement | null; info: FocusInfo } {
  const element = (target as HTMLElement | null)?.closest?.(FOCUSABLE) as HTMLElement | null;
  if (!element || !root.contains(element)) return { element: null, info: { kind: null } };
  const kind = element.dataset["swarmFocus"] as FocusKind;
  return { element, info: { kind, state: element.dataset["agentState"] ?? null, agentKind: element.dataset["agentKind"] ?? null } };
}

function step(elements: HTMLElement[], current: HTMLElement | null, delta: 1 | -1, wrap: boolean): HTMLElement | null {
  if (elements.length === 0) return null;
  const index = current ? elements.indexOf(current) : -1;
  if (index < 0) return delta > 0 ? (elements[0] ?? null) : (elements[elements.length - 1] ?? null);
  let next = index + delta;
  if (wrap) next = (next + elements.length) % elements.length;
  else next = Math.max(0, Math.min(elements.length - 1, next));
  return elements[next] ?? null;
}

/** The card's `onKeyDown`: resolves the key on the focused element and applies it. */
export function useCardKeys(root: RefObject<HTMLElement | null>, handlers: CardKeyHandlers): (event: KeyboardEvent<HTMLElement>) => void {
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const container = root.current;
      if (!container || isTyping(event.target)) return;
      const { element, info } = focusOf(container, event.target);
      const intent = resolveCardKey(event, info);
      if (!intent) return;
      // Lines an expanded card keeps folded away are in the markup but not on screen; focus skips them.
      const all = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((candidate) => candidate.offsetParent !== null);
      const id = element?.dataset["agentId"] ?? null;
      switch (intent.type) {
        case "escape":
          handlers.escape();
          break;
        case "toggle":
          handlers.toggle();
          break;
        case "openPhase":
          if (element?.dataset["phase"]) handlers.openPhase(element.dataset["phase"]);
          break;
        case "inspect":
          if (id) handlers.inspect(id);
          break;
        case "peek":
          if (id) handlers.peek(id);
          break;
        case "move": {
          const rows = all.filter((candidate) => candidate.dataset["swarmFocus"] === "row" || candidate.dataset["swarmFocus"] === "line" || candidate.dataset["swarmFocus"] === "head");
          step(rows, element, intent.delta, false)?.focus();
          break;
        }
        case "segment": {
          const segments = all.filter((candidate) => candidate.dataset["swarmFocus"] === "seg");
          step(segments, element, intent.delta, false)?.focus();
          break;
        }
        case "attention": {
          const rows = all.filter((candidate) => candidate.hasAttribute("data-attention"));
          step(rows, element, intent.delta, true)?.focus();
          break;
        }
        case "retry":
          if (id) handlers.retry(id);
          break;
        case "skip":
          if (id) handlers.skip(id);
          break;
        case "stop":
          if (id) handlers.stop(id);
          break;
        case "stopRun":
          handlers.stopRun();
          break;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [root, handlers],
  );
}
