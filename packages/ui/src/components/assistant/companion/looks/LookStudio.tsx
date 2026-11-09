import { useId, useState } from "react";
import type { AssistantCharacterView, AvatarForm, AvatarPackView, FigureSpec } from "../../../../types.js";
import { Button, cn } from "../../../ui/primitives.js";
import { Avatar } from "../Avatar.js";
import { FORMS, HUES, formInfo, hueName, randomSpec, type AvatarSpec } from "../faces.js";
import { CATALOGUE, DEFAULT_FIGURE, SHADES, SLOT_LABEL, SLOTS, describeFigure, normalizeFigure, randomFigure, sameParts, type Slot } from "../figure/parts.js";
import { PRESETS, PRESET_GROUPS, type Preset } from "../figure/presets.js";
import { usePack } from "../packs.js";
import { Card, Field, Pills, Tabs } from "../ui.js";
import { BringTab } from "./Bring.js";
import { DrawTab } from "./Draw.js";
import { MineTab } from "./Mine.js";
import { SaveFigure } from "./SaveFigure.js";

/**
 * How the user chooses and makes a look for the assistant. Five tabs: choose a ready-made character (or one of the five
 * forms of light), build one from parts, draw one in pixels, bring a picture or a sprite sheet, and the ones already made.
 * Everything edits the draft the caller holds, so the first-run flow can keep it until the assistant wakes and the Persona
 * page can save as the user goes.
 */

export type Draft = AssistantCharacterView;
export type AvatarChange = (patch: { avatar?: Partial<Draft["avatar"]> }) => void;

type Tab = "choose" | "build" | "draw" | "bring" | "mine";

const TABS_FULL = [
  { value: "choose", label: "Choose", hint: "Ready-made characters" },
  { value: "build", label: "Build", hint: "Put one together from parts" },
  { value: "draw", label: "Draw", hint: "Pixel art, frame by frame" },
  { value: "bring", label: "Bring your own", hint: "A picture or a sprite sheet" },
  { value: "mine", label: "Mine", hint: "Everything you made or brought" },
] as const;

const TABS_LITE = TABS_FULL.slice(0, 2);

const lookOf = (avatar: Draft["avatar"]) => avatar.look ?? { kind: "sigil" as const };

// ------------------------------------------------------------------------------------------------ colour

/** The colour of what it wears: a main hue, and for a figure its accent and shade; and how much it glows. */
export function ColourControls(props: { draft: Draft; onChange: AvatarChange }) {
  const { draft, onChange } = props;
  const av = draft.avatar;
  const look = lookOf(av);
  const hue = useId();
  const glow = useId();
  const figure = look.kind === "figure" ? normalizeFigure(look.figure) : null;
  const setFigure = (patch: Partial<FigureSpec>) => figure && onChange({ avatar: { look: { kind: "figure", figure: { ...figure, ...patch } } } });
  if (look.kind === "pack") {
    return (
      <Field label="Glow" hint="Its colours come from the picture. This is how much light it gives off.">
        <label htmlFor={glow} className="sr-only">Glow</label>
        <input id={glow} type="range" min={0} max={100} step={1} value={av.glow} onChange={(e) => onChange({ avatar: { glow: Number(e.currentTarget.value) } })} className="companion-range" style={{ ["--v" as string]: `${av.glow}%` }} />
      </Field>
    );
  }
  return (
    <div>
      <Field label="Colour" hint={`${hueName(av.hue)}. Pick one, or slide to any hue.`}>
        <div className="flex flex-wrap items-center gap-2">
          {HUES.map((h) => (
            <button
              key={h.name}
              type="button"
              aria-label={h.name}
              aria-pressed={Math.abs(av.hue - h.hue) < 3}
              onClick={() => onChange({ avatar: { hue: h.hue } })}
              className={cn("size-7 rounded-full transition-transform duration-150 ease-out hover:scale-110 active:scale-95", Math.abs(av.hue - h.hue) < 3 && "shadow-[0_0_0_2px_var(--bg-raised),0_0_0_3.5px_var(--fg)]")}
              style={{ background: `oklch(0.74 0.15 ${h.hue})` }}
            />
          ))}
        </div>
        <label htmlFor={hue} className="sr-only">Hue</label>
        <input id={hue} type="range" min={0} max={359} step={1} value={av.hue} onChange={(e) => onChange({ avatar: { hue: Number(e.currentTarget.value) } })} className="companion-range hue mt-3" />
      </Field>
      {figure ? (
        <>
          <Field label="Accent" hint="The colour of what it wears: ears, hats, scarves. Auto picks one that suits the colour above.">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-pressed={figure.accent === null}
                onClick={() => setFigure({ accent: null })}
                className={cn("h-7 rounded-full px-3 text-xs font-medium transition-colors", figure.accent === null ? "bg-accent-soft text-accent-text shadow-[0_0_0_1.5px_var(--accent)]" : "bg-sunken text-muted shadow-[0_0_0_1px_var(--border)] hover:bg-hover hover:text-fg")}
              >
                Auto
              </button>
              {HUES.map((h) => (
                <button
                  key={h.name}
                  type="button"
                  aria-label={`${h.name} accent`}
                  aria-pressed={figure.accent !== null && Math.abs(figure.accent - h.hue) < 3}
                  onClick={() => setFigure({ accent: h.hue })}
                  className={cn("size-6 rounded-full transition-transform duration-150 ease-out hover:scale-110 active:scale-95", figure.accent !== null && Math.abs(figure.accent - h.hue) < 3 && "shadow-[0_0_0_2px_var(--bg-raised),0_0_0_3.5px_var(--fg)]")}
                  style={{ background: `oklch(0.74 0.15 ${h.hue})` }}
                />
              ))}
            </div>
          </Field>
          <Field label="Shade" hint="From pastel to deep.">
            <Pills value={figure.shade} onChange={(shade) => setFigure({ shade })} label="Shade" options={SHADES.map((label, value) => ({ value, label }))} />
          </Field>
        </>
      ) : null}
      <Field label="Glow" hint="How much light it gives off.">
        <label htmlFor={glow} className="sr-only">Glow</label>
        <input id={glow} type="range" min={0} max={100} step={1} value={av.glow} onChange={(e) => onChange({ avatar: { glow: Number(e.currentTarget.value) } })} className="companion-range" style={{ ["--v" as string]: `${av.glow}%` }} />
      </Field>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ surprise

/** Something it has not worn: a ready-made character, a figure put together by chance, or a form of light. */
export function surprise(random: () => number = Math.random): Partial<Draft["avatar"]> {
  const r = random();
  if (r < 0.45) {
    const p = PRESETS[Math.floor(random() * PRESETS.length)] as Preset;
    return { look: { kind: "figure", figure: p.figure }, hue: p.hue, glow: p.glow, seed: 1 + Math.floor(random() * 2_000_000_000) };
  }
  if (r < 0.85) {
    return { look: { kind: "figure", figure: randomFigure(random) }, hue: (HUES[Math.floor(random() * HUES.length)] as (typeof HUES)[number]).hue, glow: 45 + Math.floor(random() * 45), seed: 1 + Math.floor(random() * 2_000_000_000) };
  }
  return { ...randomSpec(random), look: { kind: "sigil" } };
}

function Surprises(props: { onChange: AvatarChange }) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <Button size="sm" variant="secondary" onClick={() => props.onChange({ avatar: surprise() })}>
        Surprise me
      </Button>
      <Button size="sm" variant="ghost" onClick={() => props.onChange({ avatar: { seed: 1 + Math.floor(Math.random() * 2_000_000_000) } })}>
        Another take
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ choose

/** A face on a card, still until it is pointed at, so a page of thirty does not move all at once. */
const thumb = (avatar: Draft["avatar"], patch: Partial<Draft["avatar"]>): AvatarSpec => ({ ...avatar, ...patch });

export function ChooseTab(props: { draft: Draft; onChange: AvatarChange }) {
  const { draft, onChange } = props;
  const av = draft.avatar;
  const look = lookOf(av);
  const info = formInfo(av.form);
  return (
    <div>
      {PRESET_GROUPS.map((group) => (
        <Field key={group} label={group}>
          <div className="grid grid-cols-3 gap-2 @min-[480px]:grid-cols-4 @min-[720px]:grid-cols-6">
            {PRESETS.filter((p) => p.group === group).map((p) => (
              <Card
                key={p.id}
                chosen={look.kind === "figure" && sameParts(normalizeFigure(look.figure), p.figure)}
                label={p.name}
                onClick={() => onChange({ avatar: { look: { kind: "figure", figure: p.figure }, hue: p.hue, glow: p.glow } })}
                className="py-2.5"
              >
                <Avatar spec={thumb(av, { look: { kind: "figure", figure: p.figure }, hue: p.hue, glow: p.glow })} name={p.name} size={60} stage className="av-calm" />
                <span className="text-xs font-medium text-fg">{p.name}</span>
              </Card>
            ))}
          </div>
        </Field>
      ))}
      <Field label="Forms of light" hint="Made of light, not of a body. They glow, turn and watch.">
        <div className="grid grid-cols-3 gap-2 @min-[560px]:grid-cols-5">
          {FORMS.map((f) => (
            <Card key={f.form} chosen={look.kind === "sigil" && av.form === f.form} label={f.name} onClick={() => onChange({ avatar: { look: { kind: "sigil" }, form: f.form as AvatarForm } })}>
              <Avatar spec={thumb(av, { look: { kind: "sigil" }, form: f.form as AvatarForm })} size={56} stage className="av-calm" />
              <span className="text-xs font-medium text-fg">{f.name}</span>
            </Card>
          ))}
        </div>
      </Field>
      {look.kind === "sigil" ? (
        <Field label={info.variantLabel}>
          <Pills value={av.detail} onChange={(detail) => onChange({ avatar: { detail } })} label={info.variantLabel} options={info.variants.map((label, value) => ({ value, label }))} />
        </Field>
      ) : null}
      <ColourControls draft={draft} onChange={onChange} />
      <Surprises onChange={onChange} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ build

function StartBuilding(props: { draft: Draft; onChange: AvatarChange }) {
  const { draft, onChange } = props;
  const worn = lookOf(draft.avatar).kind === "pack" ? "something you drew or brought" : "a form of light";
  return (
    <div className="rounded-xl bg-sunken p-4 shadow-[0_0_0_1px_var(--border)]">
      <p className="text-sm font-medium text-fg">Build a figure from parts</p>
      <p className="mt-1 text-xs text-muted text-pretty">It is wearing {worn} now. Start from a plain figure, or from a surprise, and change anything: the body, ears, eyes, mouth, markings, what it wears, what is around it, and its finish.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="accent" onClick={() => onChange({ avatar: { look: { kind: "figure", figure: DEFAULT_FIGURE }, hue: 195, glow: 60 } })}>
          Start with a plain figure
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onChange({ avatar: surprise(() => 0.5 + Math.random() * 0.3) })}>
          Start with a surprise
        </Button>
      </div>
    </div>
  );
}

export function BuildTab(props: { draft: Draft; onChange: AvatarChange; saveable: boolean; /** The saved figure being changed, when Mine sent it here. */ editing?: AvatarPackView | null }) {
  const { draft, onChange } = props;
  const av = draft.avatar;
  const look = lookOf(av);
  const [slot, setSlot] = useState<Slot | "colour">("body");
  if (look.kind !== "figure") return <StartBuilding draft={draft} onChange={onChange} />;
  const figure = normalizeFigure(look.figure);
  const set = (patch: Partial<FigureSpec>) => onChange({ avatar: { look: { kind: "figure", figure: { ...figure, ...patch } } } });
  const shuffle = () => {
    if (slot === "colour") {
      onChange({ avatar: { hue: Math.floor(Math.random() * 360), look: { kind: "figure", figure: { ...figure, accent: Math.random() < 0.5 ? null : Math.floor(Math.random() * 360), shade: 1 + Math.floor(Math.random() * 3) } } } });
      return;
    }
    const options = CATALOGUE[slot].filter((o) => o.id !== figure[slot]);
    const pick = options[Math.floor(Math.random() * options.length)];
    if (pick) set({ [slot]: pick.id });
  };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Pills<Slot | "colour"> value={slot} onChange={setSlot} label="Part to change" options={[...SLOTS.map((s) => ({ value: s as Slot | "colour", label: SLOT_LABEL[s] })), { value: "colour", label: "Colour" }]} />
      </div>
      {slot === "colour" ? (
        <ColourControls draft={draft} onChange={onChange} />
      ) : (
        <div className="mt-3 grid grid-cols-3 gap-2 @min-[560px]:grid-cols-5 @min-[760px]:grid-cols-6" role="group" aria-label={SLOT_LABEL[slot]}>
          {CATALOGUE[slot].map((o) => (
            <Card key={o.id} chosen={figure[slot] === o.id} label={`${SLOT_LABEL[slot]}: ${o.name}`} onClick={() => set({ [slot]: o.id })} className="gap-1.5 p-2">
              <Avatar spec={av} render={{ kind: "figure", figure: { ...figure, [slot]: o.id } }} size={56} stage className="av-calm" />
              <span className="text-2xs font-medium text-fg">{o.name}</span>
            </Card>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={shuffle}>
          Shuffle {slot === "colour" ? "colours" : SLOT_LABEL[slot].toLowerCase()}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange({ avatar: surprise(() => 0.5 + Math.random() * 0.34) })}>
          Surprise me
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange({ avatar: { seed: 1 + Math.floor(Math.random() * 2_000_000_000) } })}>
          Another take
        </Button>
      </div>
      <p className="mt-2 text-xs text-subtle">It is {describeFigure(figure, av.hue)}.</p>
      {props.saveable ? <SaveFigure key={props.editing?.id ?? "new"} draft={draft} editing={props.editing ?? null} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the whole

export function LookStudio(props: { draft: Draft; onChange: AvatarChange; name: string; /** Offers drawing, bringing and the library, which keep things on the server. */ full?: boolean }) {
  const { draft, onChange } = props;
  const [tab, setTab] = useState<Tab>("choose");
  // Drawing and bringing hold work that is not saved yet (a drawing, a picture being set up), so once they have been opened
  // they stay in place, hidden, while another tab shows, and come back as they were left.
  const [opened, setOpened] = useState({ draw: false, bring: false });
  // What Mine sent to be changed: a figure goes to Build, which can save back into it; pixel art goes to the studio, which
  // opens it. `drawKey` starts the studio afresh when it is sent something else, or when what it held has been saved.
  const [buildEditId, setBuildEditId] = useState<string | null>(null);
  const [drawEditId, setDrawEditId] = useState<string | null>(null);
  const [drawKey, setDrawKey] = useState(0);
  const buildEditing = usePack(buildEditId, 0);
  const drawEditing = usePack(drawEditId, 0);
  const tabs = props.full ? TABS_FULL : TABS_LITE;
  const wear = (patch: Partial<Draft["avatar"]>) => onChange({ avatar: patch });
  const go = (next: Tab) => {
    // Changing a figure ends when the user leaves Build: coming back with another figure must not save over the old one.
    if (next !== "build") setBuildEditId(null);
    if (next === "draw" || next === "bring") setOpened((o) => ({ ...o, [next]: true }));
    setTab(next);
  };
  return (
    <div>
      <Tabs<Tab> value={tab} onChange={go} options={tabs} label="How to choose a look" />
      <div className="mt-2" role="tabpanel">
        {tab === "choose" ? <ChooseTab draft={draft} onChange={onChange} /> : null}
        {tab === "build" ? <BuildTab draft={draft} onChange={onChange} saveable={Boolean(props.full)} editing={buildEditing?.kind === "figure" ? buildEditing : null} /> : null}
        {props.full && (opened.draw || tab === "draw") ? (
          <div hidden={tab !== "draw"}>
            <DrawTab
              key={drawKey}
              draft={draft}
              name={props.name}
              edit={drawEditing ?? null}
              onWear={wear}
              onDone={() => {
                setDrawEditId(null);
                setDrawKey((k) => k + 1);
                go("mine");
              }}
            />
          </div>
        ) : null}
        {props.full && (opened.bring || tab === "bring") ? (
          <div hidden={tab !== "bring"}>
            <BringTab draft={draft} name={props.name} onWear={wear} onDone={() => go("mine")} />
          </div>
        ) : null}
        {tab === "mine" && props.full ? (
          <MineTab
            draft={draft}
            name={props.name}
            onWear={wear}
            onEdit={(to, id) => {
              if (to === "draw") {
                setDrawEditId(id);
                setDrawKey((k) => k + 1);
                setBuildEditId(null);
              } else setBuildEditId(id);
              setOpened((o) => (to === "draw" ? { ...o, draw: true } : o));
              setTab(to);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
