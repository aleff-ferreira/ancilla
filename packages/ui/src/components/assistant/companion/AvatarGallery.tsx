import type { FigureSpec } from "../../../types.js";
import { COMPANIONS, COMPANION_GROUPS } from "./companions/catalog.js";
import { FORMS, HUES, MOODS, SIGIL_FORMS, type AvatarMood, type AvatarSpec } from "./faces.js";
import { Avatar } from "./Avatar.js";
import { CATALOGUE, DEFAULT_FIGURE, SHADES, SLOTS, SLOT_LABEL, type Slot } from "./figure/parts.js";

/**
 * Every face on one page. A development view for the browser demo (`demo.html?gallery=avatars&section=...`): it is how the
 * faces are looked at side by side, and it ships nowhere else. Sections: `sigils` (the five forms of light, the default),
 * `presets` (the ready-made characters), `moods` (some characters in every mood) and `parts` (each part of a figure, one
 * row for each slot).
 */

type Section = "sigils" | "presets" | "moods" | "parts";

const figureSpec = (figure: FigureSpec, hue: number, glow: number, seed = 12345): AvatarSpec => ({ form: "halo", hue, glow, detail: 1, seed, look: { kind: "figure", figure } });

const companionSpec = (id: string, hue: number, glow: number, seed = 12345): AvatarSpec => ({ form: "halo", hue, glow, detail: 1, seed, look: { kind: "companion", id } });

function Sigils(props: { hue: number; glow: number }) {
  const { hue, glow } = props;
  const spec = (form: (typeof FORMS)[number]["form"], detail = 1, h = hue): AvatarSpec => ({ form, hue: h, glow, detail, seed: 12345 });
  return (
    <>
      <p className="mb-6 text-sm text-muted">Each geometric sigil in each mood; then its four variants; then each hue.</p>
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-x-3 border-spacing-y-3">
          <thead>
            <tr>
              <th />
              {MOODS.map((mood) => (
                <th key={mood} className="text-xs font-medium text-muted capitalize">{mood}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SIGIL_FORMS.map((f) => (
              <tr key={f.form}>
                <th className="pr-3 text-right text-xs font-medium text-muted">{f.name}</th>
                {MOODS.map((mood: AvatarMood) => (
                  <td key={mood} data-cell={`${f.form}-${mood}`}>
                    <Avatar spec={spec(f.form)} mood={mood} burst={1} size={132} stage look />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="mt-8 mb-2 text-sm font-semibold">Variants</h2>
      <div className="flex flex-wrap gap-4" data-block="variants">
        {SIGIL_FORMS.flatMap((f) => [0, 1, 2, 3].map((d) => <Avatar key={`${f.form}${d}`} spec={spec(f.form, d)} size={96} stage />))}
      </div>
      <h2 className="mt-8 mb-2 text-sm font-semibold">Hues</h2>
      <div className="flex flex-wrap gap-4" data-block="hues">
        {HUES.map((h) => (
          <Avatar key={h.name} spec={spec("optic", 1, h.hue)} size={96} stage />
        ))}
      </div>
      <h2 className="mt-8 mb-2 text-sm font-semibold">Small</h2>
      <div className="flex items-center gap-4" data-block="small">
        {SIGIL_FORMS.map((f) => (
          <Avatar key={f.form} spec={spec(f.form)} size={32} stage />
        ))}
        {SIGIL_FORMS.map((f) => (
          <Avatar key={`m${f.form}`} spec={spec(f.form)} size={48} stage />
        ))}
      </div>
    </>
  );
}

function Presets() {
  return (
    <>
      <p className="mb-4 text-sm text-muted">Studio companions, resting.</p>
      {COMPANION_GROUPS.map((group) => (
        <div key={group} className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">{group}</h2>
          <div className="flex flex-wrap gap-5" data-block={`presets-${group}`}>
            {COMPANIONS.filter((c) => c.group === group).map((c) => (
              <figure key={c.id} className="flex w-36 flex-col items-center gap-1.5" data-preset={c.id}>
                <div className="cp-card-stage w-full" style={{ ["--h" as string]: c.hue, ["--g" as string]: (c.glow / 100).toFixed(2) }}>
                  <Avatar spec={companionSpec(c.id, c.hue, c.glow)} name={c.name} size={120} look />
                </div>
                <figcaption className="text-xs font-medium text-fg">{c.name}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function Moods() {
  const picks = ["vesper", "atlas", "probe", "astrolabe", "strix", "lantern"].map((id) => COMPANIONS.find((c) => c.id === id)).filter((c): c is (typeof COMPANIONS)[number] => c !== undefined);
  return (
    <>
      <p className="mb-4 text-sm text-muted">Studio companions in every mood.</p>
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-x-2 border-spacing-y-2">
          <thead>
            <tr>
              <th />
              {MOODS.map((mood) => (
                <th key={mood} className="text-xs font-medium text-muted capitalize">{mood}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {picks.map((c) => (
              <tr key={c.id}>
                <th className="pr-3 text-right text-xs font-medium text-muted">{c.name}</th>
                {MOODS.map((mood) => (
                  <td key={mood} data-cell={`${c.id}-${mood}`}>
                    <Avatar spec={companionSpec(c.id, c.hue, c.glow)} mood={mood} burst={1} size={112} stage look />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Parts(props: { hue: number; glow: number }) {
  const base: FigureSpec = { ...DEFAULT_FIGURE, eyes: "oval", mouth: "smile", finish: "gloss" };
  const row = (slot: Slot) => (
    <div key={slot} className="mb-5">
      <h2 className="mb-2 text-sm font-semibold">{SLOT_LABEL[slot]}</h2>
      <div className="flex flex-wrap gap-4" data-block={`parts-${slot}`}>
        {CATALOGUE[slot].map((part) => (
          <figure key={part.id} className="flex w-24 flex-col items-center gap-1" data-part={`${slot}-${part.id}`}>
            <Avatar spec={figureSpec({ ...base, [slot]: part.id }, props.hue, props.glow)} size={92} stage />
            <figcaption className="text-2xs text-muted">{part.name}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
  return (
    <>
      <p className="mb-4 text-sm text-muted">Each part of a figure, one row for each slot, on the plain round body.</p>
      {SLOTS.map(row)}
      <div className="mb-5">
        <h2 className="mb-2 text-sm font-semibold">Shade</h2>
        <div className="flex flex-wrap gap-4" data-block="parts-shade">
          {SHADES.map((name, i) => (
            <figure key={name} className="flex w-24 flex-col items-center gap-1">
              <Avatar spec={figureSpec({ ...base, shade: i }, props.hue, props.glow)} size={92} stage />
              <figcaption className="text-2xs text-muted">{name}</figcaption>
            </figure>
          ))}
        </div>
      </div>
      <div className="mb-5">
        <h2 className="mb-2 text-sm font-semibold">Hues</h2>
        <div className="flex flex-wrap gap-4" data-block="parts-hues">
          {HUES.map((h) => (
            <figure key={h.name} className="flex w-24 flex-col items-center gap-1">
              <Avatar spec={figureSpec({ ...base, top: "cat", mark: "blush" }, h.hue, props.glow)} size={92} stage />
              <figcaption className="text-2xs text-muted">{h.name}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </>
  );
}

export function AvatarGallery(props: { hue?: number; glow?: number; section?: string | null }) {
  const hue = props.hue ?? 232;
  const glow = props.glow ?? 65;
  const section: Section = props.section === "presets" || props.section === "moods" || props.section === "parts" ? props.section : "sigils";
  return (
    <div className="h-screen overflow-y-auto bg-app p-8 text-fg">
      <h1 className="mb-1 text-lg font-semibold">The assistant's face</h1>
      {section === "sigils" ? <Sigils hue={hue} glow={glow} /> : null}
      {section === "presets" ? <Presets /> : null}
      {section === "moods" ? <Moods /> : null}
      {section === "parts" ? <Parts hue={hue} glow={glow} /> : null}
    </div>
  );
}
