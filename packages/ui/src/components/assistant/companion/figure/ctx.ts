import type { FigureSpec } from "../../../../types.js";
import type { BodyDef } from "./bodies.js";

/** What every part is drawn with: this figure's body (for its anchors), its own ids for gradients, and its seed. */
export interface Ctx {
  /** Makes this figure's gradient and clip ids its own, since several figures can be on one page. */
  id: string;
  body: BodyDef;
  figure: FigureSpec;
  seed: number;
}

/** Eyes shrink on a narrow face and grow on a wide one, within reason. */
export const eyeScale = (body: BodyDef): number => Math.min(1.2, Math.max(0.8, body.eyeDx / 17));
