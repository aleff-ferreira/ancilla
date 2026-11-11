/**
 * Pure geometry and sizing rules for the movable assistant window and floating avatar.
 *
 * Positions are stored as normalized center-point ratios (`xRatio`, `yRatio` in `[0, 1]`) so the companion stays in
 * the chosen corner or margin across window resizes, avatar size changes, and switches between floating-avatar mode
 * and transcript-card mode, while always clamping cleanly inside the visible viewport.
 */

export const ASSISTANT_AVATAR_MIN = 56;
export const ASSISTANT_AVATAR_MAX = 224;
export const ASSISTANT_AVATAR_DEFAULT = 116;
export const ASSISTANT_AVATAR_STEP = 12;

export type AssistantWindowMode = "float" | "card";

export interface AssistantAnchor {
  xRatio: number;
  yRatio: number;
}

export interface AvatarSizePreset {
  id: "sm" | "md" | "lg" | "xl";
  label: string;
  size: number;
}

export const AVATAR_SIZE_PRESETS: readonly AvatarSizePreset[] = [
  { id: "sm", label: "S", size: 72 },
  { id: "md", label: "M", size: 108 },
  { id: "lg", label: "L", size: 148 },
  { id: "xl", label: "XL", size: 196 },
];

export function clampAvatarSize(value: unknown, fallback = ASSISTANT_AVATAR_DEFAULT): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(ASSISTANT_AVATAR_MAX, Math.max(ASSISTANT_AVATAR_MIN, value)));
}

export function stepAvatarSize(current: number, deltaSteps: number): number {
  return clampAvatarSize(current + deltaSteps * ASSISTANT_AVATAR_STEP);
}

export function cardAvatarSize(avatarSize: number): number {
  const clamped = clampAvatarSize(avatarSize);
  return Math.round(Math.min(132, Math.max(52, clamped * 0.78)));
}

export function isValidAnchor(value: unknown): value is AssistantAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as { xRatio?: unknown; yRatio?: unknown };
  return (
    typeof v.xRatio === "number" &&
    Number.isFinite(v.xRatio) &&
    v.xRatio >= 0 &&
    v.xRatio <= 1 &&
    typeof v.yRatio === "number" &&
    Number.isFinite(v.yRatio) &&
    v.yRatio >= 0 &&
    v.yRatio <= 1
  );
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

export function clampFloatingCoords(
  left: number,
  top: number,
  viewportWidth: number,
  viewportHeight: number,
  boxWidth: number,
  boxHeight: number,
  margin = 14,
): { left: number; top: number } {
  const safeMargin = Math.max(4, margin);
  const maxLeft = Math.max(safeMargin, viewportWidth - boxWidth - safeMargin);
  const maxTop = Math.max(safeMargin, viewportHeight - boxHeight - safeMargin);
  return {
    left: Math.round(Math.min(maxLeft, Math.max(safeMargin, left))),
    top: Math.round(Math.min(maxTop, Math.max(safeMargin, top))),
  };
}

export function resolveFloatingPosition(options: {
  anchor: AssistantAnchor | null;
  viewportWidth: number;
  viewportHeight: number;
  boxWidth: number;
  boxHeight: number;
  margin?: number;
  bottomClearance?: number;
}): { left: number; top: number } {
  const margin = options.margin ?? 14;
  const bottomClearance = options.bottomClearance ?? 72;
  const vw = Math.max(240, options.viewportWidth);
  const vh = Math.max(240, options.viewportHeight);
  const bw = Math.max(48, options.boxWidth);
  const bh = Math.max(48, options.boxHeight);

  if (!options.anchor) {
    return clampFloatingCoords(vw - bw - 20, vh - bh - bottomClearance, vw, vh, bw, bh, margin);
  }

  const rawLeft = options.anchor.xRatio * vw - bw / 2;
  const rawTop = options.anchor.yRatio * vh - bh / 2;
  return clampFloatingCoords(rawLeft, rawTop, vw, vh, bw, bh, margin);
}

export function anchorFromRect(
  rect: { left: number; top: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
): AssistantAnchor {
  const vw = Math.max(1, viewportWidth);
  const vh = Math.max(1, viewportHeight);
  const clamped = clampFloatingCoords(rect.left, rect.top, vw, vh, Math.max(1, rect.width), Math.max(1, rect.height));
  return {
    xRatio: Number(clamp01((clamped.left + rect.width / 2) / vw).toFixed(4)),
    yRatio: Number(clamp01((clamped.top + rect.height / 2) / vh).toFixed(4)),
  };
}

export interface BubblePlacement {
  side: "left" | "right";
  align: "top" | "bottom" | "center";
  maxWidth: number;
}

/**
 * Picks where the floating avatar's speech and approval bubble opens so it always expands into open viewport space
 * rather than clipping off-screen.
 */
export function bubblePlacement(
  rect: { left: number; top: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
  desiredWidth = 308,
): BubblePlacement {
  const gutter = 20;
  const leftSpace = Math.max(0, rect.left - gutter);
  const rightSpace = Math.max(0, viewportWidth - (rect.left + rect.width) - gutter);
  const side: "left" | "right" = rightSpace >= leftSpace ? "right" : "left";
  const available = side === "right" ? rightSpace : leftSpace;
  const maxWidth = Math.round(Math.max(180, Math.min(desiredWidth, available > 0 ? available : desiredWidth)));

  const centerY = rect.top + rect.height / 2;
  const align: "top" | "bottom" | "center" =
    centerY > viewportHeight * 0.66 ? "bottom" : centerY < viewportHeight * 0.34 ? "top" : "center";

  return { side, align, maxWidth };
}
