import type { AssistantCharacterView, AvatarForm, AvatarMoodId } from "../../../types.js";

/**
 * The assistant's face. An avatar is a small spec (a form, a hue, how much it glows, which variant, a seed) that the
 * renderer draws as a living thing: it breathes, blinks, looks where the pointer is, and reacts to what the assistant
 * is doing. Everything here is pure, so the same spec is the same face everywhere, in a chip, on the page and in a test.
 * The five forms here are the "sigils", made of light; `look` on the spec says when it wears something else (a figure
 * built from parts, or a pack the user drew or brought), and `look.ts` turns that into what is drawn.
 */

export type AvatarSpec = AssistantCharacterView["avatar"];

/** What the face is doing. The first is the resting one; a transient (delight, concern) is brief and returns to the resting mood. */
export type AvatarMood = AvatarMoodId;
export const MOODS: readonly AvatarMood[] = ["idle", "working", "attention", "delight", "concern", "asleep"];

export interface FormInfo {
  form: AvatarForm;
  name: string;
  /** One line that says what it is. */
  blurb: string;
  /** Names of its four variants, in order. */
  variants: readonly [string, string, string, string];
  /** What the variant control is called for this form. */
  variantLabel: string;
}

export const FORMS: readonly FormInfo[] = [
  { form: "halo", name: "Halo", blurb: "A core of light held by turning rings.", variantLabel: "Rings", variants: ["Two rings", "Three rings", "Rings and ticks", "Four rings"] },
  { form: "optic", name: "Optic", blurb: "One lens that watches, blinks and follows you.", variantLabel: "Lens", variants: ["Six blades", "Eight blades", "Ten blades", "Twelve blades"] },
  { form: "hologram", name: "Hologram", blurb: "A projected figure drawn in light.", variantLabel: "Face", variants: ["Eyes", "Visor", "Headband", "Headset"] },
  { form: "critter", name: "Critter", blurb: "A small creature with a lot to say with its eyes.", variantLabel: "Ears", variants: ["Round", "Cat", "Bunny", "Antenna"] },
  { form: "cipher", name: "Cipher", blurb: "A sigil that wakes when it has something to tell you.", variantLabel: "Sides", variants: ["Three", "Four", "Five", "Six"] },
];

export const formInfo = (form: AvatarForm): FormInfo => FORMS.find((f) => f.form === form) ?? (FORMS[0] as FormInfo);

export interface HueInfo {
  name: string;
  hue: number;
}

/** Hues in OKLCH degrees: named so that they can be told to a screen reader and picked at a glance. */
export const HUES: readonly HueInfo[] = [
  { name: "Ice", hue: 232 },
  { name: "Teal", hue: 195 },
  { name: "Mint", hue: 160 },
  { name: "Lime", hue: 125 },
  { name: "Amber", hue: 85 },
  { name: "Ember", hue: 45 },
  { name: "Rose", hue: 10 },
  { name: "Orchid", hue: 340 },
  { name: "Violet", hue: 295 },
];

/** The named hue nearest to this one, around the circle. */
export function hueName(hue: number): string {
  let best = HUES[0] as HueInfo;
  let gap = 360;
  for (const h of HUES) {
    const d = Math.abs(((hue - h.hue + 540) % 360) - 180);
    if (d < gap) {
      gap = d;
      best = h;
    }
  }
  return best.name;
}

export function glowName(glow: number): string {
  return glow < 25 ? "faint glow" : glow < 60 ? "soft glow" : glow < 85 ? "bright glow" : "blazing glow";
}

/** "a" or "an" before a phrase, by its first letter: "an ice hologram", "a teal halo". */
export const withArticle = (phrase: string): string => `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;

/** The colour and the form, in lower case: "ice hologram". */
export const looksLike = (spec: AvatarSpec): string => `${hueName(spec.hue).toLowerCase()} ${formInfo(spec.form).name.toLowerCase()}`;

/** What the face is doing, in words a screen reader can use. */
export const moodPhrase = (mood: AvatarMood): string =>
  mood === "asleep" ? "asleep" : mood === "working" ? "working" : mood === "attention" ? "wants your attention" : mood === "delight" ? "pleased" : mood === "concern" ? "concerned" : "resting";

/** What a screen reader says for the face: its form, colour and mood. */
export function describeAvatar(spec: AvatarSpec, name: string, mood: AvatarMood = "idle"): string {
  return `${name}, ${withArticle(looksLike(spec))} with a ${glowName(spec.glow)}, ${moodPhrase(mood)}`;
}

/** A small, fast, seedable generator, so the little touches of a face (blink timing, particles, proportions) are the same each time. */
export function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A face the user has not seen before: a form, a hue from the named ones, and a seed. */
export function randomSpec(random: () => number = Math.random): AvatarSpec {
  const form = (FORMS[Math.floor(random() * FORMS.length)] as FormInfo).form;
  const hue = (HUES[Math.floor(random() * HUES.length)] as HueInfo).hue;
  return { form, hue, glow: 45 + Math.floor(random() * 45), detail: Math.floor(random() * 4), seed: 1 + Math.floor(random() * 2_000_000_000) };
}

/** The values the stylesheet turns into colours: hue and glow, and the seed's small variations as plain numbers. */
export function avatarVars(spec: AvatarSpec): Record<string, string | number> {
  const r = rng(spec.seed);
  return {
    "--h": spec.hue,
    "--g": (spec.glow / 100).toFixed(2),
    // Blinks come every four to eight seconds, from a different moment for each face.
    "--blink": `${(4 + r() * 4).toFixed(2)}s`,
    "--blink-at": `${(r() * 4).toFixed(2)}s`,
    // The breath is a little faster or slower for each face, so two of them side by side do not move as one.
    "--breath": `${(4.4 + r() * 1.6).toFixed(2)}s`,
  };
}

/** Positions for a few drifting particles, from the seed: x in the 160-unit box, a delay and a duration in seconds. */
export function particles(seed: number, count: number): { x: number; delay: number; duration: number; size: number }[] {
  const r = rng(seed ^ 0x9e3779b9);
  return Array.from({ length: count }, () => ({ x: 50 + r() * 60, delay: r() * 6, duration: 4 + r() * 4, size: 0.8 + r() * 1.4 }));
}

/** The corners of a regular polygon of `sides` around the centre of the 160-unit box, the first pointing up. */
export function polygon(sides: number, radius: number, turn = 0): [number, number][] {
  return Array.from({ length: sides }, (_, i) => {
    const a = -Math.PI / 2 + turn + (i * 2 * Math.PI) / sides;
    return [80 + Math.cos(a) * radius, 80 + Math.sin(a) * radius] as [number, number];
  });
}

export const pointsOf = (corners: readonly [number, number][]): string => corners.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
