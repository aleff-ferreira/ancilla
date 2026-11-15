export type ZoomStep = "in" | "out" | "reset";

export interface KeyModifierSnapshot {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  code: string;
}

function hasValidZoomModifier(event: KeyModifierSnapshot, mac: boolean): boolean {
  if (event.altKey) {
    return false;
  }
  return mac ? (event.metaKey && !event.ctrlKey) : (event.ctrlKey && !event.metaKey);
}

const ZOOM_IN_CODES = new Set(["Equal", "NumpadAdd"]);
const ZOOM_IN_KEYS = new Set(["=", "+"]);
const ZOOM_OUT_CODES = new Set(["Minus", "NumpadSubtract"]);
const ZOOM_OUT_KEYS = new Set(["-", "_"]);
const ZOOM_RESET_CODES = new Set(["Digit0", "Numpad0"]);

/**
 * Translates keyboard zoom shortcuts into a canonical ZoomStep action.
 * Evaluates both physical keyboard codes and character keys to ensure layout independence.
 */
export function zoomStepFromKey(event: KeyModifierSnapshot, mac: boolean): ZoomStep | null {
  if (!hasValidZoomModifier(event, mac)) {
    return null;
  }

  const { code, key, shiftKey } = event;

  if (ZOOM_IN_CODES.has(code) || ZOOM_IN_KEYS.has(key)) {
    return "in";
  }

  if (ZOOM_OUT_CODES.has(code) || ZOOM_OUT_KEYS.has(key)) {
    return "out";
  }

  if (!shiftKey && (ZOOM_RESET_CODES.has(code) || key === "0")) {
    return "reset";
  }

  return null;
}
