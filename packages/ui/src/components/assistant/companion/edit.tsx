import { useId, useState } from "react";
import type { AssistantCharacterView, VoiceArchetype } from "../../../types.js";
import { Button, cn } from "../../ui/primitives.js";
import { Avatar } from "./Avatar.js";
import { MOODS, type AvatarMood } from "./faces.js";
import { wornWords } from "./look.js";
import { LookStudio } from "./looks/LookStudio.js";
import { usePack } from "./packs.js";
import { Card, Field } from "./ui.js";
import { ARCHETYPES, DIALS, archetypeInfo, dialWord, greeting, say } from "./voice.js";

/**
 * The controls that make the assistant someone: a look (a character to choose, build, draw or bring), a voice (an
 * archetype and five dials), what it calls the user and a few habits. They edit a draft the caller holds, so the first-run
 * flow can keep the whole character until the user wakes it, and the Persona tab can save as the user goes.
 */

export type Draft = AssistantCharacterView;

type Change = (patch: { avatar?: Partial<Draft["avatar"]>; voice?: Partial<Draft["voice"]>; callsUser?: string; quirks?: string[] }) => void;

// ------------------------------------------------------------------------------------------------ the look

/**
 * Choosing and making a look. `full` adds drawing, bringing a picture and the library of what was made, which keep their
 * things on the server; the first-run flow, which may not have one yet, offers the ready-made characters and the builder.
 */
export function LookEditor(props: { draft: Draft; onChange: Change; name?: string; full?: boolean }) {
  return <LookStudio draft={props.draft} onChange={props.onChange} name={props.name ?? "Assistant"} {...(props.full ? { full: true } : {})} />;
}

// ------------------------------------------------------------------------------------------------ the voice

function Dial(props: { dial: (typeof DIALS)[number]; value: number; onChange: (value: number) => void }) {
  const id = useId();
  const word = dialWord(props.dial.key, props.value);
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm text-fg">{props.dial.label}</label>
        <span className="text-xs text-muted">{word}</span>
      </div>
      <input id={id} type="range" min={0} max={4} step={1} value={props.value} aria-valuetext={word} onChange={(e) => props.onChange(Number(e.currentTarget.value))} className="companion-range mt-1.5" style={{ ["--v" as string]: `${props.value * 25}%` }} />
      <div className="mt-1 flex justify-between text-2xs text-subtle">
        <span>{props.dial.low}</span>
        <span>{props.dial.high}</span>
      </div>
    </div>
  );
}

/** How it would say a few things, in the voice as it is now: no model, the same lines the app uses. */
export function Samples(props: { draft: Draft; name: string; now?: number }) {
  const at = props.now ?? Date.now();
  const vars = { name: props.name, task: "the audit", n: 2 };
  const rows: [string, string][] = [
    ["Greeting", greeting(props.draft, vars, at)],
    ["Something waiting", say("needs", props.draft, vars, at)],
    ["A note kept", say("remembered", props.draft, vars, at)],
    ["A task finished", say("taskDone", props.draft, vars, at)],
  ];
  return (
    <div className="rounded-xl bg-sunken p-3 shadow-[0_0_0_1px_var(--border)]" aria-label="How it would say it">
      <p className="mb-1.5 text-2xs font-medium tracking-wide text-subtle uppercase">How it would say it</p>
      <ul className="space-y-1">
        {rows.map(([what, line]) => (
          <li key={what} className="flex gap-2 text-sm">
            <span className="w-28 shrink-0 text-xs leading-5 text-subtle">{what}</span>
            <span className="min-w-0 text-fg [overflow-wrap:anywhere]">&ldquo;{line}&rdquo;</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function VoiceEditor(props: { draft: Draft; name: string; onChange: Change }) {
  const { draft, onChange } = props;
  const callsId = useId();
  const quirks = draft.quirks;
  return (
    <div>
      <Field label="Voice" hint={archetypeInfo(draft.voice.archetype).blurb}>
        <div className="grid grid-cols-2 gap-2 @min-[560px]:grid-cols-4">
          {ARCHETYPES.map((a) => (
            <Card
              key={a.archetype}
              chosen={draft.voice.archetype === a.archetype}
              label={a.name}
              onClick={() => onChange({ voice: { archetype: a.archetype as VoiceArchetype, ...a.dials } })}
              className="items-start text-left"
            >
              <span className="text-sm font-medium text-fg">{a.name}</span>
              <span className="line-clamp-3 text-xs text-muted">{a.blurb}</span>
            </Card>
          ))}
        </div>
      </Field>
      <Field label="Dials" hint="Each moves what it says and how it is told to sound. Choosing a voice sets them to that voice's own.">
        <div className="divide-y divide-line rounded-xl bg-sunken px-3 shadow-[0_0_0_1px_var(--border)]">
          {DIALS.map((d) => (
            <Dial key={d.key} dial={d} value={draft.voice[d.key]} onChange={(value) => onChange({ voice: { [d.key]: value } })} />
          ))}
        </div>
      </Field>
      <Field label="What it calls you" hint="A name or a nickname. Leave it empty and it will not use one.">
        <input
          id={callsId}
          type="text"
          aria-label="What it calls you"
          maxLength={40}
          value={draft.callsUser}
          placeholder="Alex"
          onChange={(e) => onChange({ callsUser: e.currentTarget.value })}
          className="h-9 w-full max-w-72 rounded-lg bg-sunken px-3 text-sm text-fg shadow-[0_0_0_1px_var(--border)] outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus"
        />
      </Field>
      <Field label="Habits" hint="Up to four small things it does or never does, in your own words.">
        <div className="space-y-2">
          {quirks.map((q, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="text"
                aria-label={`Habit ${i + 1}`}
                maxLength={80}
                value={q}
                onChange={(e) => onChange({ quirks: quirks.map((x, j) => (j === i ? e.currentTarget.value : x)) })}
                className="h-9 min-w-0 flex-1 rounded-lg bg-sunken px-3 text-sm text-fg shadow-[0_0_0_1px_var(--border)] outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus"
              />
              <Button size="sm" variant="ghost" onClick={() => onChange({ quirks: quirks.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
          ))}
          {quirks.length < 4 ? (
            <Button size="sm" variant="secondary" onClick={() => onChange({ quirks: [...quirks, ""] })}>
              Add a habit
            </Button>
          ) : null}
          {quirks.length === 0 ? <p className="text-xs text-subtle">For example: &ldquo;Signs off with &lsquo;Standing by.&rsquo;&rdquo; or &ldquo;Never explains a joke.&rdquo;</p> : null}
        </div>
      </Field>
      <Samples draft={draft} name={props.name} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the preview

const MOOD_LABEL: Record<AvatarMood, string> = { idle: "Resting", working: "Working", attention: "Needs you", delight: "Pleased", concern: "Concerned", asleep: "Asleep" };

/** The face at a size to enjoy, in whatever mood you try on it, with the line it would say to open. */
export function Preview(props: { draft: Draft; name: string; size?: number; line?: string | undefined }) {
  const [mood, setMood] = useState<AvatarMood>("idle");
  const [burst, setBurst] = useState(0);
  const worn = props.draft.avatar.look?.kind === "pack" ? props.draft.avatar.look : null;
  const wornPack = usePack(worn?.id ?? null, worn?.rev ?? 0);
  const pick = (m: AvatarMood) => {
    setMood(m);
    setBurst(Date.now());
  };
  const vars = { ["--h" as string]: props.draft.avatar.hue, ["--g" as string]: (props.draft.avatar.glow / 100).toFixed(2) };
  // The card measures itself, not the page: in a narrow column the face stands on its stage above the words, and where
  // there is room the stage sits beside them.
  return (
    <div className="companion-preview @container">
      <div className="flex flex-col @min-[440px]:flex-row">
        <div className="ch-stage compact @min-[440px]:w-48 @min-[440px]:shrink-0" style={vars}>
          <Avatar spec={props.draft.avatar} name={props.name} mood={mood} burst={burst} size={props.size ?? 120} look />
        </div>
        <div className="min-w-0 flex-1 p-4 @min-[440px]:self-center @min-[440px]:p-5">
          <p className="font-display text-xl text-fg [overflow-wrap:anywhere]">{props.name}</p>
          <p className="mt-0.5 text-xs text-muted">
            {archetypeInfo(props.draft.voice.archetype).name} voice, {wornWords(props.draft.avatar, wornPack)}
          </p>
          {props.line ? <p className="mt-2 text-sm leading-5 text-fg [overflow-wrap:anywhere]">&ldquo;{props.line}&rdquo;</p> : null}
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Try a mood">
            {MOODS.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mood === m}
                onClick={() => pick(m)}
                className={cn("h-6 rounded-md px-2 text-2xs font-medium whitespace-nowrap transition-colors", mood === m ? "bg-accent-soft text-accent-text" : "bg-sunken text-subtle hover:bg-hover hover:text-fg")}
              >
                {MOOD_LABEL[m]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
