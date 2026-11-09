import type { FigureSpec } from "../../../../types.js";
import { normalizeFigure } from "./parts.js";

/**
 * Characters ready to wear: a figure's parts, the colour it was drawn in and how much it glows. Each is only a starting
 * point: the colour, the shade and every part can be changed after choosing one, and the Persona page keeps what is changed.
 */

export type PresetGroup = "Creatures" | "Machines" | "Spirits" | "Folk";

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  group: PresetGroup;
  hue: number;
  glow: number;
  figure: FigureSpec;
}

const fig = (f: Partial<FigureSpec>): FigureSpec => normalizeFigure(f);

export const PRESETS: readonly Preset[] = [
  // ---- creatures
  { id: "fox", name: "Fox", blurb: "Quick, bright and a little sly.", group: "Creatures", hue: 40, glow: 55, figure: fig({ body: "wide", top: "fox", eyes: "oval", mouth: "cat", mark: "belly", gear: "tail", finish: "plush", accent: 75, shade: 2 }) },
  { id: "cat", name: "Tabby", blurb: "Watches everything and says little.", group: "Creatures", hue: 70, glow: 50, figure: fig({ body: "blob", top: "cat", eyes: "slit", mouth: "cat", mark: "stripes", finish: "matte", accent: 20, shade: 2 }) },
  { id: "bunny", name: "Bunny", blurb: "Soft, curious, always listening.", group: "Creatures", hue: 350, glow: 60, figure: fig({ body: "egg", top: "bunny", eyes: "round", mouth: "tiny", mark: "blush", finish: "plush", accent: 10, shade: 1 }) },
  { id: "bear", name: "Bear", blurb: "Steady and warm, hard to rattle.", group: "Creatures", hue: 55, glow: 40, figure: fig({ body: "blob", top: "round", eyes: "dot", mouth: "smile", mark: "belly", finish: "plush", accent: 55, shade: 3 }) },
  { id: "owl", name: "Owl", blurb: "Notices what others miss.", group: "Creatures", hue: 62, glow: 45, figure: fig({ body: "egg", top: "cat", eyes: "owl", mouth: "beak", mark: "belly", finish: "matte", accent: 85, shade: 3 }) },
  { id: "penguin", name: "Penguin", blurb: "Formal, dependable, a little bit funny.", group: "Creatures", hue: 255, glow: 45, figure: fig({ body: "egg", top: "none", eyes: "dot", mouth: "beak", mark: "belly", gear: "scarf", finish: "gloss", accent: 55, shade: 4 }) },
  { id: "dragon", name: "Dragonling", blurb: "Small, fierce and on your side.", group: "Creatures", hue: 150, glow: 65, figure: fig({ body: "blob", top: "horns", eyes: "slit", mouth: "fang", gear: "wings", aura: "embers", finish: "gloss", accent: 60, shade: 2 }) },
  { id: "raccoon", name: "Bandit", blurb: "Finds the thing you lost.", group: "Creatures", hue: 260, glow: 45, figure: fig({ body: "wide", top: "round", eyes: "oval", mouth: "smile", mark: "mask", gear: "tail", finish: "plush", accent: 85, shade: 3 }) },
  // ---- machines
  { id: "robot", name: "Robot", blurb: "Precise, patient, fully booted.", group: "Machines", hue: 232, glow: 70, figure: fig({ body: "box", top: "antenna", eyes: "visor", mouth: "grille", mark: "circuit", finish: "metal", aura: "data", accent: 185, shade: 2 }) },
  { id: "drone", name: "Drone", blurb: "Hovers over the work and reports back.", group: "Machines", hue: 195, glow: 70, figure: fig({ body: "saucer", top: "none", eyes: "lens", mouth: "none", finish: "metal", aura: "orbit", accent: 45, shade: 2 }) },
  { id: "retro", name: "Terminal", blurb: "Green phosphor and one clear thought.", group: "Machines", hue: 150, glow: 80, figure: fig({ body: "box", top: "twin", eyes: "pixel", mouth: "flat", finish: "neon", aura: "data", accent: 150, shade: 3 }) },
  { id: "cyclops", name: "Cyclops", blurb: "One big eye and a bigger grin.", group: "Machines", hue: 130, glow: 60, figure: fig({ body: "pill", top: "antenna", eyes: "lens", mouth: "grin", finish: "gloss", accent: 40, shade: 2 }) },
  { id: "operator", name: "Operator", blurb: "On the line and ready to help.", group: "Machines", hue: 285, glow: 65, figure: fig({ body: "pill", top: "none", eyes: "visor", mouth: "none", gear: "headset", finish: "glass", accent: 330, shade: 2 }) },
  { id: "cog", name: "Tinkerer", blurb: "Takes things apart to understand them.", group: "Machines", hue: 70, glow: 50, figure: fig({ body: "box", top: "twin", eyes: "round", mouth: "smile", gear: "glasses", finish: "matte", accent: 200, shade: 2 }) },
  // ---- spirits
  { id: "ghost", name: "Ghost", blurb: "Drifts through the problem and out the other side.", group: "Spirits", hue: 232, glow: 70, figure: fig({ body: "ghost", top: "none", eyes: "dot", mouth: "tiny", mark: "blush", finish: "glass", aura: "sparkle", accent: 340, shade: 0 }) },
  { id: "slime", name: "Slime", blurb: "Friendly, squishy and very hard to stop.", group: "Spirits", hue: 160, glow: 55, figure: fig({ body: "bean", top: "sprout", eyes: "oval", mouth: "smile", finish: "glass", aura: "bubbles", accent: 110, shade: 2 }) },
  { id: "jelly", name: "Jelly", blurb: "Floats along and glows when it thinks.", group: "Spirits", hue: 305, glow: 80, figure: fig({ body: "jelly", top: "none", eyes: "round", mouth: "tiny", finish: "glass", aura: "bubbles", accent: 200, shade: 1 }) },
  { id: "ember", name: "Ember", blurb: "A small flame with a lot to say.", group: "Spirits", hue: 40, glow: 90, figure: fig({ body: "flame", top: "none", eyes: "dot", mouth: "smile", finish: "gloss", aura: "embers", accent: 90, shade: 2 }) },
  { id: "droplet", name: "Droplet", blurb: "Calm, clear and always moving.", group: "Spirits", hue: 225, glow: 60, figure: fig({ body: "drop", top: "none", eyes: "oval", mouth: "smile", mark: "blush", finish: "glass", aura: "bubbles", accent: 190, shade: 1 }) },
  { id: "nimbus", name: "Nimbus", blurb: "Sleepy on the outside, busy up there.", group: "Spirits", hue: 232, glow: 50, figure: fig({ body: "cloud", top: "none", eyes: "sleepy", mouth: "smile", mark: "blush", finish: "plush", aura: "none", accent: 350, shade: 0 }) },
  { id: "shroom", name: "Morel", blurb: "Quiet, a bit odd, grows on you.", group: "Spirits", hue: 85, glow: 40, figure: fig({ body: "shroom", top: "none", eyes: "dot", mouth: "smile", mark: "spots", finish: "matte", aura: "none", accent: 20, shade: 1 }) },
  { id: "prism", name: "Prism", blurb: "Splits a hard question into clear colours.", group: "Spirits", hue: 300, glow: 85, figure: fig({ body: "gem", top: "none", eyes: "ring", mouth: "none", finish: "glass", aura: "sparkle", accent: 200, shade: 1 }) },
  // ---- folk
  { id: "mage", name: "Mage", blurb: "Has read the book. Has read the other book.", group: "Folk", hue: 280, glow: 65, figure: fig({ body: "egg", top: "wizard", eyes: "round", mouth: "smile", finish: "gloss", aura: "sparkle", accent: 85, shade: 3 }) },
  { id: "regent", name: "Regent", blurb: "Gracious, decisive, wears the cape well.", group: "Folk", hue: 20, glow: 55, figure: fig({ body: "blob", top: "crown", eyes: "oval", mouth: "smile", gear: "cape", finish: "gloss", accent: 85, shade: 2 }) },
  { id: "cool", name: "Maverick", blurb: "Sunglasses, indoors, at all times.", group: "Folk", hue: 330, glow: 60, figure: fig({ body: "blob", top: "mohawk", eyes: "dot", mouth: "grin", gear: "shades", finish: "ink", accent: 200, shade: 2 }) },
  { id: "angel", name: "Seraph", blurb: "Gentle, patient, a little luminous.", group: "Folk", hue: 232, glow: 75, figure: fig({ body: "egg", top: "halo", eyes: "dot", mouth: "smile", mark: "blush", gear: "wings", finish: "plush", accent: 85, shade: 0 }) },
  { id: "seedling", name: "Seedling", blurb: "Small now. Give it time.", group: "Folk", hue: 130, glow: 50, figure: fig({ body: "bean", top: "sprout", eyes: "dot", mouth: "smile", mark: "blush", finish: "plush", accent: 100, shade: 2 }) },
  { id: "bard", name: "Bard", blurb: "Hums while it works.", group: "Folk", hue: 195, glow: 60, figure: fig({ body: "blob", top: "beanie", eyes: "oval", mouth: "smile", gear: "headphones", aura: "notes", finish: "gloss", accent: 30, shade: 2 }) },
];

export const PRESET_GROUPS: readonly PresetGroup[] = ["Creatures", "Machines", "Spirits", "Folk"];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);
