import { useCallback, type KeyboardEvent, type RefObject } from "react";
import { isTyping } from "../requests/Requests.js";

/**
 * Keyboard navigation and action dispatcher for Crew card interface elements (SPEC §11).
 */
export type FocusKind = "line" | "head" | "seg" | "row";

export interface KeyLike {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

export interface FocusInfo {
  readonly kind: FocusKind | null;
  readonly agentKind?: string | null;
  readonly state?: string | null;
}

export type CardIntent =
  | { type: "escape" } | { type: "toggle" } | { type: "openPhase" } | { type: "inspect" }
  | { type: "peek" } | { type: "move"; delta: 1 | -1 } | { type: "segment"; delta: 1 | -1 }
  | { type: "attention"; delta: 1 | -1 } | { type: "retry" } | { type: "skip" }
  | { type: "stop" } | { type: "stopRun" };

export function resolveCardKey(event: KeyLike, targetFocus: FocusInfo): CardIntent | null {
  const hasModifier = Boolean(event.ctrlKey || event.metaKey || event.altKey);
  if (hasModifier) {
    return null;
  }

  const keyPressed = event.key;
  if (keyPressed === "Escape") {
    return { type: "escape" };
  }

  const kind = targetFocus.kind;
  if (kind === null) {
    return null;
  }

  if (keyPressed === "Enter" || keyPressed === " ") {
    if (kind === "line" || kind === "head") {
      return { type: "toggle" };
    }
    if (kind === "seg") {
      return { type: "openPhase" };
    }
    return keyPressed === "Enter" ? { type: "inspect" } : { type: "peek" };
  }

  if (keyPressed === "ArrowDown" || keyPressed === "j") {
    return { type: "move", delta: 1 };
  }
  if (keyPressed === "ArrowUp" || keyPressed === "k") {
    return { type: "move", delta: -1 };
  }

  if (kind === "seg") {
    if (keyPressed === "ArrowRight") return { type: "segment", delta: 1 };
    if (keyPressed === "ArrowLeft") return { type: "segment", delta: -1 };
  }

  if (keyPressed === "n" || keyPressed === "N") {
    const isReverse = Boolean(event.shiftKey || keyPressed === "N");
    return { type: "attention", delta: isReverse ? -1 : 1 };
  }

  if (kind === "row") {
    if (keyPressed === "r" && targetFocus.state === "failed") {
      return { type: "retry" };
    }
    const isWorkflowTarget = targetFocus.agentKind === "workflow" && targetFocus.state !== "planned";
    if (keyPressed === "s" && isWorkflowTarget) {
      return { type: "skip" };
    }
    if (keyPressed === "x") {
      return { type: "stop" };
    }
  }

  const isCardHeaderOrSummary = kind === "head" || kind === "line";
  if (isCardHeaderOrSummary && keyPressed === "x") {
    return { type: "stopRun" };
  }

  return null;
}

export interface CardKeyHandlers {
  readonly toggle: () => void;
  readonly escape: () => void;
  readonly openPhase: (phaseName: string) => void;
  readonly inspect: (agentId: string) => void;
  readonly peek: (agentId: string) => void;
  readonly retry: (agentId: string) => void;
  readonly skip: (agentId: string) => void;
  readonly stop: (agentId: string) => void;
  readonly stopRun: () => void;
}

const SELECTOR_CREW_FOCUSABLE = "[data-crew-focus]";

function locateFocusTarget(container: HTMLElement, target: EventTarget | null): { element: HTMLElement | null; info: FocusInfo } {
  const elem = (target as HTMLElement | null)?.closest?.(SELECTOR_CREW_FOCUSABLE) as HTMLElement | null;
  if (!elem || !container.contains(elem)) {
    return { element: null, info: { kind: null } };
  }
  const focusKind = elem.dataset["crewFocus"] as FocusKind;
  return {
    element: elem,
    info: {
      kind: focusKind,
      state: elem.dataset["agentState"] ?? null,
      agentKind: elem.dataset["agentKind"] ?? null,
    },
  };
}

function advanceFocus(items: HTMLElement[], activeItem: HTMLElement | null, offset: 1 | -1, loop: boolean): HTMLElement | null {
  if (items.length === 0) return null;
  const currentIdx = activeItem ? items.indexOf(activeItem) : -1;
  if (currentIdx === -1) {
    return offset > 0 ? (items[0] ?? null) : (items[items.length - 1] ?? null);
  }
  let targetIdx = currentIdx + offset;
  if (loop) {
    targetIdx = (targetIdx + items.length) % items.length;
  } else {
    targetIdx = Math.max(0, Math.min(items.length - 1, targetIdx));
  }
  return items[targetIdx] ?? null;
}

export function useCardKeys(cardRootRef: RefObject<HTMLElement | null>, actionHandlers: CardKeyHandlers): (event: KeyboardEvent<HTMLElement>) => void {
  return useCallback(
    (keyEvent: KeyboardEvent<HTMLElement>) => {
      const containerNode = cardRootRef.current;
      if (!containerNode || isTyping(keyEvent.target)) {
        return;
      }

      const { element, info } = locateFocusTarget(containerNode, keyEvent.target);
      const matchedIntent = resolveCardKey(keyEvent, info);
      if (!matchedIntent) {
        return;
      }

      const interactiveCandidates = [...containerNode.querySelectorAll<HTMLElement>(SELECTOR_CREW_FOCUSABLE)].filter(
        (node) => node.offsetParent !== null && node.closest("[inert]") === null,
      );

      const targetAgentId = element?.dataset["agentId"] ?? null;

      switch (matchedIntent.type) {
        case "escape":
          actionHandlers.escape();
          break;
        case "toggle":
          actionHandlers.toggle();
          break;
        case "openPhase": {
          const phaseName = element?.dataset["phase"];
          if (phaseName) actionHandlers.openPhase(phaseName);
          break;
        }
        case "inspect":
          if (targetAgentId) actionHandlers.inspect(targetAgentId);
          break;
        case "peek":
          if (targetAgentId) actionHandlers.peek(targetAgentId);
          break;
        case "move": {
          const navigableRows = interactiveCandidates.filter(
            (c) => c.dataset["crewFocus"] === "row" || c.dataset["crewFocus"] === "line" || c.dataset["crewFocus"] === "head",
          );
          advanceFocus(navigableRows, element, matchedIntent.delta, false)?.focus();
          break;
        }
        case "segment": {
          const railSegments = interactiveCandidates.filter((c) => c.dataset["crewFocus"] === "seg");
          advanceFocus(railSegments, element, matchedIntent.delta, false)?.focus();
          break;
        }
        case "attention": {
          const attentionRows = interactiveCandidates.filter((c) => c.hasAttribute("data-attention"));
          advanceFocus(attentionRows, element, matchedIntent.delta, true)?.focus();
          break;
        }
        case "retry":
          if (targetAgentId) actionHandlers.retry(targetAgentId);
          break;
        case "skip":
          if (targetAgentId) actionHandlers.skip(targetAgentId);
          break;
        case "stop":
          if (targetAgentId) actionHandlers.stop(targetAgentId);
          break;
        case "stopRun":
          actionHandlers.stopRun();
          break;
      }

      keyEvent.preventDefault();
      keyEvent.stopPropagation();
    },
    [cardRootRef, actionHandlers],
  );
}
