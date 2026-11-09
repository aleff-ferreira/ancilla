import type { AvatarPackView, FigureSpec, ImagePackData, PixelData } from "../../../types.js";
import { describeAvatar, hueName, looksLike, moodPhrase, withArticle, type AvatarMood, type AvatarSpec } from "./faces.js";
import { describeFigure, normalizeFigure, partName, sameParts } from "./figure/parts.js";
import { PRESETS } from "./figure/presets.js";

/**
 * What the assistant wears, resolved to something that can be drawn. The profile stores a small `look` (a sigil, a figure
 * with its parts, or the id of a saved pack); the pack's own data (pixels, a picture) lives on the server and is read through
 * the cache in `packs.tsx`. This turns the first into the second, and says in words what it is for a screen reader.
 */

export type RenderLook =
  | { kind: "sigil" }
  | { kind: "figure"; figure: FigureSpec }
  | { kind: "pixel"; data: PixelData; name?: string }
  | { kind: "image"; data: ImagePackData; name?: string };

/** What a pack is, as a look. A figure kept in the library is drawn as a figure. */
export function lookOfPack(pack: AvatarPackView): RenderLook {
  if (pack.kind === "figure") return { kind: "figure", figure: normalizeFigure(pack.data.figure) };
  if (pack.kind === "pixel") return { kind: "pixel", data: pack.data, name: pack.name };
  return { kind: "image", data: pack.data, name: pack.name };
}

/** The look the spec names, given the pack it points at once that is known; the plain sigil while it is not. */
export function resolveLook(spec: AvatarSpec, pack: AvatarPackView | undefined): RenderLook {
  const look = spec.look;
  if (!look || look.kind === "sigil") return { kind: "sigil" };
  if (look.kind === "figure") return { kind: "figure", figure: normalizeFigure(look.figure) };
  return pack ? lookOfPack(pack) : { kind: "sigil" };
}

/** The pack a spec asks for, if it asks for one. */
export const packRef = (spec: AvatarSpec): { id: string; rev: number } | null => (spec.look?.kind === "pack" ? { id: spec.look.id, rev: spec.look.rev } : null);

/** The ready-made character a figure is made of, if it is one: the same parts, in whatever colour. */
export const presetOf = (figure: FigureSpec): (typeof PRESETS)[number] | undefined => PRESETS.find((p) => sameParts(p.figure, normalizeFigure(figure)));

/** What it wears, in a few words for the line under its picture: "ice halo", "teal fox", "pixel art called Pip". */
export function wornWords(spec: AvatarSpec, pack?: AvatarPackView): string {
  const look = spec.look;
  if (!look || look.kind === "sigil") return looksLike(spec);
  if (look.kind === "figure") {
    const preset = presetOf(look.figure);
    return `${hueName(spec.hue).toLowerCase()} ${preset ? preset.name.toLowerCase() : `${partName("body", normalizeFigure(look.figure).body).toLowerCase()} figure`}`;
  }
  if (!pack) return "a drawing of its own";
  return `${pack.kind === "image" ? "a picture" : "pixel art"} called ${pack.name}`;
}

/** A sentence about what it wears: "An ice halo.", "A teal fox.", "Pixel art called Pip.". */
export function wornSentence(spec: AvatarSpec, pack?: AvatarPackView): string {
  const words = wornWords(spec, pack);
  const phrase = spec.look?.kind === "pack" ? words : withArticle(words);
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`;
}

/** What a screen reader says: who it is, what it looks like, and what it is doing. */
export function describeLook(spec: AvatarSpec, name: string, mood: AvatarMood, look: RenderLook): string {
  switch (look.kind) {
    case "figure":
      return `${name}, ${describeFigure(look.figure, spec.hue)}, ${moodPhrase(mood)}`;
    case "pixel":
      return `${name}, a pixel art avatar${look.name ? ` called ${look.name}` : ""}, ${moodPhrase(mood)}`;
    case "image":
      return `${name}, a picture avatar${look.name ? ` called ${look.name}` : ""}, ${moodPhrase(mood)}`;
    default:
      return describeAvatar(spec, name, mood);
  }
}
