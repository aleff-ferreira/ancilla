import type { FigureSpec } from "../../../../types.js";
import { hueName, rng, withArticle } from "../faces.js";

/**
 * The catalogue of a figure's parts. A figure is ten small values (see `FigureSpec`): eight of them name a part by id and
 * two are numbers, so a whole character is a few dozen bytes, can be carried in the profile, shared as text and drawn the
 * same everywhere. Everything here is pure: the drawing is in `Figure.tsx`, the colours are in the stylesheet.
 *
 * An id the catalogue does not know is not an error. It draws the plain part for its slot, so a figure saved by a newer
 * Ancilla (with a part this one has not heard of) still shows, only plainer.
 */

export type Slot = "body" | "top" | "eyes" | "mouth" | "mark" | "gear" | "aura" | "finish";

export interface PartInfo {
  id: string;
  name: string;
}

export const BODIES: readonly PartInfo[] = [
  { id: "blob", name: "Round" },
  { id: "egg", name: "Egg" },
  { id: "wide", name: "Wide" },
  { id: "bean", name: "Slime" },
  { id: "pill", name: "Capsule" },
  { id: "box", name: "Block" },
  { id: "ghost", name: "Ghost" },
  { id: "drop", name: "Droplet" },
  { id: "gem", name: "Crystal" },
  { id: "cloud", name: "Cloud" },
  { id: "shroom", name: "Mushroom" },
  { id: "saucer", name: "Saucer" },
  { id: "flame", name: "Flame" },
  { id: "jelly", name: "Jelly" },
];

export const TOPS: readonly PartInfo[] = [
  { id: "none", name: "Nothing" },
  { id: "round", name: "Round ears" },
  { id: "cat", name: "Cat ears" },
  { id: "fox", name: "Fox ears" },
  { id: "bunny", name: "Long ears" },
  { id: "horns", name: "Little horns" },
  { id: "antenna", name: "Antenna" },
  { id: "twin", name: "Two antennae" },
  { id: "sprout", name: "Sprout" },
  { id: "tuft", name: "Tuft" },
  { id: "crown", name: "Crown" },
  { id: "halo", name: "Halo" },
  { id: "beanie", name: "Beanie" },
  { id: "wizard", name: "Wizard hat" },
  { id: "flame", name: "Flame" },
  { id: "mohawk", name: "Mohawk" },
  { id: "bow", name: "Bow" },
];

export const EYES: readonly PartInfo[] = [
  { id: "dot", name: "Dots" },
  { id: "oval", name: "Ovals" },
  { id: "round", name: "Bright" },
  { id: "slit", name: "Slits" },
  { id: "sleepy", name: "Sleepy" },
  { id: "visor", name: "Visor" },
  { id: "lens", name: "One lens" },
  { id: "pixel", name: "Pixels" },
  { id: "ring", name: "Rings" },
  { id: "owl", name: "Goggles" },
];

export const MOUTHS: readonly PartInfo[] = [
  { id: "smile", name: "Smile" },
  { id: "cat", name: "Cat" },
  { id: "flat", name: "Flat" },
  { id: "tiny", name: "Tiny" },
  { id: "grin", name: "Grin" },
  { id: "fang", name: "Fangs" },
  { id: "tongue", name: "Tongue" },
  { id: "beak", name: "Beak" },
  { id: "grille", name: "Grille" },
  { id: "none", name: "None" },
];

export const MARKS: readonly PartInfo[] = [
  { id: "none", name: "None" },
  { id: "blush", name: "Blush" },
  { id: "freckles", name: "Freckles" },
  { id: "stripes", name: "Stripes" },
  { id: "spots", name: "Spots" },
  { id: "belly", name: "Belly" },
  { id: "mask", name: "Mask" },
  { id: "gem", name: "Gem" },
  { id: "bolt", name: "Bolt" },
  { id: "circuit", name: "Circuit" },
];

export const GEAR: readonly PartInfo[] = [
  { id: "none", name: "Nothing" },
  { id: "glasses", name: "Glasses" },
  { id: "shades", name: "Shades" },
  { id: "monocle", name: "Monocle" },
  { id: "headphones", name: "Headphones" },
  { id: "headset", name: "Headset" },
  { id: "scarf", name: "Scarf" },
  { id: "bowtie", name: "Bow tie" },
  { id: "wings", name: "Wings" },
  { id: "tail", name: "Tail" },
  { id: "cape", name: "Cape" },
];

export const AURAS: readonly PartInfo[] = [
  { id: "none", name: "Nothing" },
  { id: "glow", name: "Glow" },
  { id: "sparkle", name: "Sparkles" },
  { id: "orbit", name: "Orbiting dots" },
  { id: "embers", name: "Embers" },
  { id: "bubbles", name: "Bubbles" },
  { id: "petals", name: "Petals" },
  { id: "data", name: "Falling bits" },
  { id: "notes", name: "Music" },
  { id: "hearts", name: "Hearts" },
];

export const FINISHES: readonly PartInfo[] = [
  { id: "gloss", name: "Glossy" },
  { id: "matte", name: "Matte" },
  { id: "plush", name: "Plush" },
  { id: "glass", name: "Glass" },
  { id: "metal", name: "Metal" },
  { id: "neon", name: "Neon" },
  { id: "ink", name: "Ink" },
];

export const CATALOGUE: Record<Slot, readonly PartInfo[]> = {
  body: BODIES,
  top: TOPS,
  eyes: EYES,
  mouth: MOUTHS,
  mark: MARKS,
  gear: GEAR,
  aura: AURAS,
  finish: FINISHES,
};

export const SLOTS: readonly Slot[] = ["body", "top", "eyes", "mouth", "mark", "gear", "aura", "finish"];

export const SLOT_LABEL: Record<Slot, string> = {
  body: "Body",
  top: "On top",
  eyes: "Eyes",
  mouth: "Mouth",
  mark: "Markings",
  gear: "Wearing",
  aura: "Around it",
  finish: "Finish",
};

/** The shade steps, lightest first: what the control shows and what a screen reader says. */
export const SHADES: readonly string[] = ["Pastel", "Soft", "Vivid", "Rich", "Deep"];

/** What it starts as, and what a part becomes when the catalogue does not know its id. */
export const DEFAULT_FIGURE: FigureSpec = { body: "blob", top: "none", eyes: "oval", mouth: "smile", mark: "none", gear: "none", aura: "none", finish: "gloss", accent: null, shade: 2 };

export const knownPart = (slot: Slot, id: string): boolean => CATALOGUE[slot].some((p) => p.id === id);

export function partName(slot: Slot, id: string): string {
  return (CATALOGUE[slot].find((p) => p.id === id) ?? CATALOGUE[slot][0])?.name ?? id;
}

const whole = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback);

/**
 * A figure made safe to draw: an id the catalogue does not know becomes the plain part of its slot, and the numbers are
 * brought inside their limits. Never throws, so whatever was saved still shows something.
 */
export function normalizeFigure(raw: Partial<FigureSpec> | null | undefined): FigureSpec {
  const r: Partial<FigureSpec> = raw ?? {};
  const pick = (slot: Slot, value: unknown): string => (typeof value === "string" && knownPart(slot, value) ? value : DEFAULT_FIGURE[slot]);
  return {
    body: pick("body", r.body),
    top: pick("top", r.top),
    eyes: pick("eyes", r.eyes),
    mouth: pick("mouth", r.mouth),
    mark: pick("mark", r.mark),
    gear: pick("gear", r.gear),
    aura: pick("aura", r.aura),
    finish: pick("finish", r.finish),
    // Anything that is not a hue is the automatic accent, not red.
    accent: typeof r.accent === "number" && Number.isFinite(r.accent) ? whole(r.accent, 0, 359, 0) : null,
    shade: whole(r.shade, 0, 4, DEFAULT_FIGURE.shade),
  };
}

export const sameFigure = (a: FigureSpec, b: FigureSpec): boolean => SLOTS.every((s) => a[s] === b[s]) && a.accent === b.accent && a.shade === b.shade;

/** Whether two figures are made of the same parts, however they are coloured: a fox with another accent is still that fox. */
export const sameParts = (a: FigureSpec, b: FigureSpec): boolean => SLOTS.every((s) => a[s] === b[s]);

/** The accent colour's hue: the one chosen, or the one that sets the main hue off (a split complement, which reads as lively without clashing). */
export const accentHue = (figure: FigureSpec, hue: number): number => (figure.accent ?? (hue + 150) % 360);

/** How each kind of eyes is said in a sentence. */
const EYES_PHRASE: Record<string, string> = {
  dot: "dot eyes",
  oval: "oval eyes",
  round: "bright eyes",
  slit: "slit eyes",
  sleepy: "sleepy eyes",
  visor: "a visor",
  lens: "one lens for an eye",
  pixel: "pixel eyes",
  ring: "ring eyes",
  owl: "goggle eyes",
};

/** In words, for a screen reader and for the line under the preview: "a teal round figure with cat ears and bright eyes". */
export function describeFigure(figure: FigureSpec, hue: number): string {
  const f = normalizeFigure(figure);
  const top = f.top === "none" ? "" : ` with ${partName("top", f.top).toLowerCase()}`;
  const eyes = EYES_PHRASE[f.eyes] ?? "plain eyes";
  const glue = top ? " and" : " with";
  return `${withArticle(`${hueName(hue).toLowerCase()} ${partName("body", f.body).toLowerCase()} figure`)}${top}${glue} ${eyes}`;
}

/**
 * A figure nobody has seen before. Parts that read as plain are likelier than busy ones, so most draws are charming rather
 * than cluttered; `keep` leaves chosen slots as `base` has them, which is what a lock on a slot means.
 */
export function randomFigure(random: () => number = Math.random, base: FigureSpec = DEFAULT_FIGURE, keep: Partial<Record<Slot | "colour", boolean>> = {}): FigureSpec {
  const one = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const maybe = (slot: Slot, chance: number): string => (random() < chance ? (one(CATALOGUE[slot].filter((p) => p.id !== "none")) as PartInfo).id : "none");
  const out: FigureSpec = {
    body: (one(BODIES) as PartInfo).id,
    top: maybe("top", 0.72),
    eyes: (one(EYES) as PartInfo).id,
    mouth: (one(MOUTHS.filter((m) => m.id !== "none" || random() < 0.15)) as PartInfo).id,
    mark: maybe("mark", 0.5),
    gear: maybe("gear", 0.4),
    aura: maybe("aura", 0.5),
    finish: (one(FINISHES) as PartInfo).id,
    accent: random() < 0.5 ? null : Math.floor(random() * 360),
    shade: 1 + Math.floor(random() * 3),
  };
  const merged: FigureSpec = { ...out };
  for (const slot of SLOTS) if (keep[slot]) merged[slot] = base[slot];
  if (keep.colour) {
    merged.accent = base.accent;
    merged.shade = base.shade;
  }
  return merged;
}

/** Small deterministic touches of a figure (where spots fall, where sparkles sit) from its seed, so two draws of one figure agree. */
export function touches(seed: number, count: number): { a: number; b: number; c: number; d: number }[] {
  const r = rng((seed ^ 0x51ed270b) >>> 0);
  return Array.from({ length: count }, () => ({ a: r(), b: r(), c: r(), d: r() }));
}
