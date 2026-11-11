import { useId, useState } from "react";
import type { AssistantCharacterView, AvatarForm, AvatarPackView, FigureSpec } from "../../../../types.js";
import { Button, cn } from "../../../ui/primitives.js";
import { Avatar } from "../Avatar.js";
import { COMPANIONS, COMPANION_GROUPS, companionById, type CompanionInfo } from "../companions/catalog.js";
import { HUES, SIGIL_FORMS, formInfo, hueName, randomSpec, type AvatarSpec } from "../faces.js";
import { CATALOGUE, DEFAULT_FIGURE, SHADES, SLOT_LABEL, SLOTS, describeFigure, normalizeFigure, type Slot } from "../figure/parts.js";
import { usePack } from "../packs.js";
import { Card, Field, Pills, Tabs } from "../ui.js";
import { BringTab } from "./Bring.js";
import { DrawTab } from "./Draw.js";
import { MineTab } from "./Mine.js";
import { SaveFigure } from "./SaveFigure.js";

/**
 * How the user chooses and imports a look for the assistant: studio-rendered companions and minimal geometric sigils on
 * Choose, bringing a picture / sprite sheet / desktop-pet `.zip`, drawing pixel art frame by frame, and managing saved
 * looks in Mine. Legacy part-built figures saved in Mine remain editable without cluttering the main tabs.
 */

export type Draft = AssistantCharacterView;
export type AvatarChange = (patch: { avatar?: Partial<Draft["avatar"]> }) => void;

type VisibleTab = "choose" | "bring" | "draw" | "mine";
type Tab = VisibleTab | "build";

const TABS_FULL: readonly { value: VisibleTab; label: string; hint: string }[] = [
  { value: "choose", label: "Choose", hint: "Studio companions and sigils" },
  { value: "bring", label: "Bring your own", hint: "Picture, sprite sheet or pet .zip" },
  { value: "draw", label: "Draw", hint: "Pixel art, frame by frame" },
  { value: "mine", label: "Mine", hint: "Everything you brought or made" },
];

const lookOf = (avatar: Draft["avatar"]) => avatar.look ?? { kind: "sigil" as const };

// ------------------------------------------------------------------------------------------------ colour

/** Stage & aura lighting: main hue, glow intensity, and legacy figure accent/shade when editing an old figure. */
export function ColourControls(props: { draft: Draft; onChange: AvatarChange }) {
  const { draft, onChange } = props;
  const av = draft.avatar;
  const look = lookOf(av);
  const hue = useId();
  const glow = useId();
  const figure = look.kind === "figure" ? normalizeFigure(look.figure) : null;
  const companion = look.kind === "companion" ? companionById(look.id) : undefined;
  const setFigure = (patch: Partial<FigureSpec>) => figure && onChange({ avatar: { look: { kind: "figure", figure: { ...figure, ...patch } } } });
  if (look.kind === "pack") {
    return (
      <Field label="Glow" hint="Its colours come from the picture. This sets the stage and rim light around it.">
        <label htmlFor={glow} className="sr-only">Glow</label>
        <input id={glow} type="range" min={0} max={100} step={1} value={av.glow} onChange={(e) => onChange({ avatar: { glow: Number(e.currentTarget.value) } })} className="companion-range" style={{ ["--v" as string]: `${av.glow}%` }} />
      </Field>
    );
  }
  const colourLabel = companion ? "Stage and aura light" : "Colour";
  const colourHint = companion
    ? `${hueName(av.hue)}. Tints the stage, ambient rim halo and telemetry ring around ${companion.name}.`
    : `${hueName(av.hue)}. Pick one, or slide to any hue.`;
  const customCompanionLight = Boolean(companion && (av.hue !== companion.hue || av.glow !== companion.glow));
  return (
    <div>
      <Field label={colourLabel} hint={colourHint}>
        <div className="flex flex-wrap items-center gap-2">
          {companion ? (
            <button
              type="button"
              aria-pressed={!customCompanionLight}
              onClick={() => onChange({ avatar: { hue: companion.hue, glow: companion.glow } })}
              className={cn("h-7 rounded-full px-3 text-xs font-medium transition-colors", !customCompanionLight ? "bg-accent-soft text-accent-text shadow-[0_0_0_1.5px_var(--accent)]" : "bg-sunken text-muted shadow-[0_0_0_1px_var(--border)] hover:bg-hover hover:text-fg")}
            >
              Signature
            </button>
          ) : null}
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
      <Field label="Glow" hint="How much light it casts onto the stage and rim.">
        <label htmlFor={glow} className="sr-only">Glow</label>
        <input id={glow} type="range" min={0} max={100} step={1} value={av.glow} onChange={(e) => onChange({ avatar: { glow: Number(e.currentTarget.value) } })} className="companion-range" style={{ ["--v" as string]: `${av.glow}%` }} />
      </Field>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ surprise

/** Picks a studio companion or one of the geometric forms of light. */
export function surprise(random: () => number = Math.random): Partial<Draft["avatar"]> {
  const r = random();
  if (r < 0.82) {
    const c = COMPANIONS[Math.floor(random() * COMPANIONS.length)] as CompanionInfo;
    return { look: { kind: "companion", id: c.id }, hue: c.hue, glow: c.glow, seed: 1 + Math.floor(random() * 2_000_000_000) };
  }
  return { ...randomSpec(random), look: { kind: "sigil" } };
}

function Surprises(props: { onChange: AvatarChange; showSeed: boolean }) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <Button size="sm" variant="secondary" onClick={() => props.onChange({ avatar: surprise() })}>
        Surprise me
      </Button>
      {props.showSeed ? (
        <Button size="sm" variant="ghost" onClick={() => props.onChange({ avatar: { seed: 1 + Math.floor(Math.random() * 2_000_000_000) } })}>
          Another take
        </Button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ choose

const thumb = (avatar: Draft["avatar"], patch: Partial<Draft["avatar"]>): AvatarSpec => ({ ...avatar, ...patch });

export function ChooseTab(props: { draft: Draft; onChange: AvatarChange; onOpenBring?: () => void }) {
  const { draft, onChange } = props;
  const av = draft.avatar;
  const look = lookOf(av);
  const info = formInfo(av.form);
  return (
    <div>
      {COMPANION_GROUPS.map((group) => (
        <Field key={group} label={group}>
          <div className="grid grid-cols-2 gap-2.5 @min-[440px]:grid-cols-3 @min-[680px]:grid-cols-4">
            {COMPANIONS.filter((c) => c.group === group).map((c) => {
              const chosen = look.kind === "companion" && look.id === c.id;
              const h = chosen ? av.hue : c.hue;
              const g = chosen ? av.glow : c.glow;
              return (
                <Card
                  key={c.id}
                  chosen={chosen}
                  label={c.name}
                  onClick={() => onChange({ avatar: { look: { kind: "companion", id: c.id }, hue: c.hue, glow: c.glow } })}
                  className="items-stretch gap-2 p-2 text-left"
                >
                  <div className="cp-card-stage" style={{ ["--h" as string]: h, ["--g" as string]: (g / 100).toFixed(2) }}>
                    <Avatar spec={thumb(av, { look: { kind: "companion", id: c.id }, hue: h, glow: g })} name={c.name} size={92} className="av-calm" />
                  </div>
                  <div className="px-1 pb-0.5">
                    <span className="block text-xs font-semibold text-fg">{c.name}</span>
                    <span className="cp-card-blurb mt-0.5 text-2xs leading-3.5 text-muted">{c.blurb}</span>
                  </div>
                </Card>
              );
            })}
          </div>
        </Field>
      ))}
      <Field label="Forms of light" hint="Minimal geometric instruments made of light. They turn, focus and watch.">
        <div className="grid grid-cols-3 gap-2.5">
          {SIGIL_FORMS.map((f) => {
            const chosen = look.kind === "sigil" && av.form === f.form;
            return (
              <Card key={f.form} chosen={chosen} label={f.name} onClick={() => onChange({ avatar: { look: { kind: "sigil" }, form: f.form as AvatarForm } })} className="py-2.5">
                <Avatar spec={thumb(av, { look: { kind: "sigil" }, form: f.form as AvatarForm })} size={60} stage className="av-calm" />
                <span className="text-xs font-medium text-fg">{f.name}</span>
              </Card>
            );
          })}
        </div>
      </Field>
      {look.kind === "sigil" ? (
        <Field label={info.variantLabel}>
          <Pills value={av.detail} onChange={(detail) => onChange({ avatar: { detail } })} label={info.variantLabel} options={info.variants.map((label, value) => ({ value, label }))} />
        </Field>
      ) : null}
      <ColourControls draft={draft} onChange={onChange} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Surprises onChange={onChange} showSeed={look.kind === "sigil"} />
        {props.onOpenBring ? (
          <Button size="sm" variant="ghost" onClick={props.onOpenBring}>
            Import desktop-pet .zip or sprite sheet
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ legacy figure editor (for Mine)

function StartBuilding(props: { draft: Draft; onChange: AvatarChange }) {
  const { draft, onChange } = props;
  const kind = lookOf(draft.avatar).kind;
  const worn = kind === "pack" ? "something you drew or brought" : kind === "companion" ? "a studio companion" : "a form of light";
  return (
    <div className="rounded-xl bg-sunken p-4 shadow-[0_0_0_1px_var(--border)]">
      <p className="text-sm font-medium text-fg">Build a figure from parts</p>
      <p className="mt-1 text-xs text-muted text-pretty">It is wearing {worn} now. Start from a plain figure to edit individual parts.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="accent" onClick={() => onChange({ avatar: { look: { kind: "figure", figure: DEFAULT_FIGURE }, hue: 195, glow: 60 } })}>
          Start with a plain figure
        </Button>
      </div>
    </div>
  );
}

export function BuildTab(props: { draft: Draft; onChange: AvatarChange; saveable: boolean; /** The saved figure being changed, when Mine sent it here. */ editing?: AvatarPackView | null; onBack?: () => void }) {
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
      {props.onBack ? (
        <div className="mb-2">
          <Button size="xs" variant="ghost" onClick={props.onBack}>
            Back to Mine
          </Button>
        </div>
      ) : null}
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

export function LookStudio(props: { draft: Draft; onChange: AvatarChange; name: string; /** Offers bringing, drawing and the library, which keep things on the server. */ full?: boolean }) {
  const { draft, onChange } = props;
  const [tab, setTab] = useState<Tab>("choose");
  // Drawing and bringing hold work that is not saved yet (a drawing, a picture being set up), so once they have been opened
  // they stay in place, hidden, while another tab shows, and come back as they were left.
  const [opened, setOpened] = useState({ draw: false, bring: false });
  const [buildEditId, setBuildEditId] = useState<string | null>(null);
  const [drawEditId, setDrawEditId] = useState<string | null>(null);
  const [drawKey, setDrawKey] = useState(0);
  const buildEditing = usePack(buildEditId, 0);
  const drawEditing = usePack(drawEditId, 0);
  const wear = (patch: Partial<Draft["avatar"]>) => onChange({ avatar: patch });
  const go = (next: Tab) => {
    if (next !== "build") setBuildEditId(null);
    if (next === "draw" || next === "bring") setOpened((o) => ({ ...o, [next]: true }));
    setTab(next);
  };
  if (!props.full) {
    return <ChooseTab draft={draft} onChange={onChange} />;
  }
  const activeVisible: VisibleTab = tab === "build" ? "mine" : tab;
  return (
    <div>
      <Tabs<VisibleTab> value={activeVisible} onChange={go} options={TABS_FULL} label="How to choose a look" />
      <div className="mt-2" role="tabpanel">
        {tab === "choose" ? <ChooseTab draft={draft} onChange={onChange} onOpenBring={() => go("bring")} /> : null}
        {tab === "build" ? <BuildTab draft={draft} onChange={onChange} saveable editing={buildEditing?.kind === "figure" ? buildEditing : null} onBack={() => go("mine")} /> : null}
        {opened.draw || tab === "draw" ? (
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
        {opened.bring || tab === "bring" ? (
          <div hidden={tab !== "bring"}>
            <BringTab draft={draft} name={props.name} onWear={wear} onDone={() => go("mine")} />
          </div>
        ) : null}
        {tab === "mine" ? (
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
