import { COMPANION_ART } from "./art.generated.js";

/**
 * Built-in studio companions: sculpted 3D chassis, autonomous instruments and cybernetic constructs rendered with
 * tactile materials (porcelain ceramic, brushed titanium, aged bronze, obsidian, smoked quartz) on clear cutouts.
 * Their ambient rim light, stage floor and telemetry rings take the user's chosen hue and glow.
 */

export const COMPANION_GROUPS = ["Cores & Chassis", "Drones & Instruments", "Constructs"] as const;
export type CompanionGroup = (typeof COMPANION_GROUPS)[number];

export interface CompanionInfo {
  id: string;
  name: string;
  group: CompanionGroup;
  /** Short craft description for cards and assistive tech. */
  blurb: string;
  /** Default stage and aura hue in OKLCH degrees (0..359). */
  hue: number;
  /** Default stage and aura glow (0..100). */
  glow: number;
  /** Optical focal center in the 160x160 avatar viewBox for subtle pointer-tracking glint and working telemetry. */
  optic: { cx: number; cy: number; r: number };
  /** Embedded 256x256 RGBA WebP data URL. */
  src: string;
}

export const DEFAULT_COMPANION_ID = "vesper";

export const COMPANIONS: readonly CompanionInfo[] = [
  // ---- Cores & Chassis
  {
    id: "vesper",
    name: "Vesper",
    group: "Cores & Chassis",
    blurb: "Articulated white-ceramic chassis with dark gunmetal linkages and a warm amber optic.",
    hue: 75,
    glow: 68,
    optic: { cx: 88, cy: 74, r: 9 },
    src: COMPANION_ART.vesper,
  },
  {
    id: "atlas",
    name: "Orbital Core",
    group: "Cores & Chassis",
    blurb: "Gimballed steel and white-enamel personality sphere with an iris-shuttered sapphire lens.",
    hue: 228,
    glow: 72,
    optic: { cx: 85, cy: 78, r: 14 },
    src: COMPANION_ART.atlas,
  },
  {
    id: "turret",
    name: "Sentry Pod",
    group: "Cores & Chassis",
    blurb: "Sleek porcelain and carbon-fiber autonomous pod with a recessed crimson visor.",
    hue: 12,
    glow: 66,
    optic: { cx: 69, cy: 76, r: 8 },
    src: COMPANION_ART.turret,
  },
  {
    id: "obelisk",
    name: "Reliquary",
    group: "Cores & Chassis",
    blurb: "Faceted obsidian and titanium monolith inlaid with gold circuits and twin violet crystals.",
    hue: 285,
    glow: 70,
    optic: { cx: 80, cy: 78, r: 16 },
    src: COMPANION_ART.obelisk,
  },

  // ---- Drones & Instruments
  {
    id: "probe",
    name: "Recon Probe",
    group: "Drones & Instruments",
    blurb: "Slate-titanium and copper aerospace hover-drone with twin thrusters and a teal sensor lens.",
    hue: 192,
    glow: 66,
    optic: { cx: 68, cy: 82, r: 8 },
    src: COMPANION_ART.probe,
  },
  {
    id: "astrolabe",
    name: "Chronometer",
    group: "Drones & Instruments",
    blurb: "Interlocking engraved brass gimbal rings suspending a smoked-glass amber filament core.",
    hue: 82,
    glow: 70,
    optic: { cx: 80, cy: 79, r: 15 },
    src: COMPANION_ART.astrolabe,
  },
  {
    id: "phosphor",
    name: "Terminal",
    group: "Drones & Instruments",
    blurb: "Retro-industrial laboratory oscilloscope with brass dials and a phosphor-emerald CRT ring.",
    hue: 155,
    glow: 64,
    optic: { cx: 88, cy: 76, r: 15 },
    src: COMPANION_ART.phosphor,
  },
  {
    id: "nautilus",
    name: "Bathysphere",
    group: "Drones & Instruments",
    blurb: "Riveted bronze and cast-iron deep-sea probe with a bolted amber searchlight viewport.",
    hue: 45,
    glow: 66,
    optic: { cx: 69, cy: 82, r: 11 },
    src: COMPANION_ART.nautilus,
  },

  // ---- Constructs
  {
    id: "strix",
    name: "Automaton Owl",
    group: "Constructs",
    blurb: "Layered matte-porcelain and dark-bronze mechanical owl with clockwork gears and amber lenses.",
    hue: 78,
    glow: 64,
    optic: { cx: 74, cy: 61, r: 9 },
    src: COMPANION_ART.strix,
  },
  {
    id: "kitsune",
    name: "Cybernetic Fox",
    group: "Constructs",
    blurb: "Segmented white-ceramic and carbon construct with cyan optical visors.",
    hue: 198,
    glow: 68,
    optic: { cx: 58, cy: 60, r: 7 },
    src: COMPANION_ART.kitsune,
  },
  {
    id: "aegis",
    name: "Valkyrie",
    group: "Constructs",
    blurb: "Brushed silver-titanium and gunmetal sentinel helm with a luminous ice-blue visor slit.",
    hue: 232,
    glow: 68,
    optic: { cx: 71, cy: 81, r: 10 },
    src: COMPANION_ART.aegis,
  },
  {
    id: "lantern",
    name: "Arcane Core",
    group: "Constructs",
    blurb: "Wrought-iron and bevelled smoked-glass containment lantern housing an orchid plasma crystal.",
    hue: 325,
    glow: 74,
    optic: { cx: 80, cy: 84, r: 15 },
    src: COMPANION_ART.lantern,
  },
];

export const companionById = (id: string): CompanionInfo | undefined => COMPANIONS.find((c) => c.id === id);
