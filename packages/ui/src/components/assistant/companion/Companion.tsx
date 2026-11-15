import { useNow, useApp } from "../../../app/context.js";
import type { AssistantStatusView, MemoryListView } from "../../../types.js";
import { Button } from "../../ui/primitives.js";
import { Section } from "../../settings/SettingsPage.js";
import { ago, day, useAssistantData } from "../api.js";
import { Chip } from "../parts.js";
import { Avatar } from "./Avatar.js";
import { wornSentence } from "./look.js";
import { stateOf, useFaceMood } from "./mood.js";
import { usePack } from "./packs.js";
import { ARCHETYPES, DIALS, dialWord, greeting, milestoneText, say } from "./voice.js";
import type { AssistantGlance } from "../../../model/store.js";

/** What the sidebar's card and the dock read, built from the page's own, fuller answer. */
export function glanceOf(status: AssistantStatusView): AssistantGlance {
  return {
    enabled: status.profile.enabled,
    name: status.profile.name,
    character: status.profile.character,
    open: status.tasks?.open ?? 0,
    needsYou: status.tasks?.needsYou ?? 0,
    running: status.tasks?.running ?? 0,
  };
}

/** The two dials that stand out most, as a few words: "jokes often, direct". */
export function leanings(status: AssistantStatusView): string {
  const v = status.profile.character.voice;
  const base = ARCHETYPES.find((a) => a.archetype === v.archetype)?.dials;
  const ranked = DIALS.map((d) => ({ d, value: v[d.key], away: Math.abs(v[d.key] - (base ? base[d.key] : 2)) + Math.abs(v[d.key] - 2) * 0.5 }))
    .filter((x) => x.value !== 2)
    .sort((a, b) => b.away - a.away)
    .slice(0, 2);
  return ranked.map((x) => dialWord(x.d.key, x.value)).join(", ");
}

/** The line it opens with, in its voice, from what is true now: what waits on you, what it is doing, or that all is quiet. */
export function openingLine(glance: AssistantGlance, now: number): string {
  const c = glance.character;
  const vars = { name: glance.name, n: glance.needsYou, task: "your task" };
  switch (stateOf(glance)) {
    case "invite": return say("invite", c, vars, now);
    case "off": return say("off", c, vars, now);
    case "needs": return `${greeting(c, vars, now)} ${say("needs", c, vars, now)}`;
    case "working": return `${greeting(c, vars, now)} ${say("working", c, vars, now)}`;
    default: return `${greeting(c, vars, now)} ${say("idle", c, vars, now)}`;
  }
}

/**
 * The assistant, front and centre: its face on a stage, its name, what kind of voice it has, the line it opens with and
 * what you have shared. Before it is set up it asks to be, and it is plain that this is the first thing to do.
 */
export function CompanionHero(props: { status: AssistantStatusView; onMake: () => void; onWake: () => void; onPersona: () => void }) {
  const { status } = props;
  const reaction = useApp((s) => s.assistantReaction);
  const now = useNow(60_000);
  const glance = glanceOf(status);
  const face = useFaceMood(glance, reaction);
  const state = stateOf(glance);
  const ch = glance.character;
  const bond = status.bond;
  const worn = ch.avatar.look?.kind === "pack" ? ch.avatar.look : null;
  const wornPack = usePack(worn?.id ?? null, worn?.rev ?? 0);
  const vars = { ["--h" as string]: ch.avatar.hue, ["--g" as string]: (ch.avatar.glow / 100).toFixed(2) };
  const facts: string[] = [];
  if (ch.showBond && bond.since !== null) {
    facts.push(bond.daysTogether <= 0 ? "Together since today" : bond.daysTogether === 1 ? "1 day together" : `${bond.daysTogether} days together`);
    if (bond.remembered > 0) facts.push(`${bond.remembered} remembered`);
    if (bond.finished > 0) facts.push(`${bond.finished} finished together`);
    if (bond.replaced > 0) facts.push(`${bond.replaced} change${bond.replaced === 1 ? "" : "s"} of mind kept`);
  }
  return (
    <section aria-label={`${glance.name}, your assistant`} className="companion-hero grid overflow-hidden rounded-2xl bg-raised shadow-panel @min-[560px]:grid-cols-[232px_minmax(0,1fr)]">
      <div className="ch-stage" style={vars}>
        <Avatar spec={ch.avatar} name={glance.name} mood={face.mood} burst={face.burst} size={176} look />
      </div>
      <div className="flex min-w-0 flex-col justify-center gap-3 p-5 @min-[560px]:p-6">
        <div>
          <p className="text-2xs font-medium tracking-wide text-subtle uppercase">{state === "invite" ? "Meet your assistant" : "Your assistant"}</p>
          <h2 className="mt-0.5 font-display text-[28px] leading-8 tracking-[-0.01em] text-fg [overflow-wrap:anywhere]">{glance.name}</h2>
          <p className="mt-1 text-sm text-muted">
            {ARCHETYPES.find((a) => a.archetype === ch.voice.archetype)?.name ?? "Steady"} voice
            {leanings(status) ? `, ${leanings(status)}` : ""}. {wornSentence(ch.avatar, wornPack)}
          </p>
        </div>
        <p className="border-l-2 pl-3 text-[15px] leading-6 text-fg [overflow-wrap:anywhere]" style={{ borderColor: `oklch(0.72 0.15 ${ch.avatar.hue} / 0.7)` }}>
          {openingLine(glance, now)}
        </p>
        {facts.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {facts.map((f) => (
              <Chip key={f}>{f}</Chip>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-1">
          {state === "invite" ? (
            <Button variant="accent" onClick={props.onMake}>
              Make it yours
            </Button>
          ) : null}
          {state === "off" ? (
            <Button variant="accent" onClick={props.onWake}>
              Switch it on
            </Button>
          ) : null}
          {state !== "invite" ? (
            <Button variant="secondary" size="md" onClick={props.onPersona}>
              Change its look and voice
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** A slim version of the same, for the tabs under Home: it is the same someone, whichever page you are on. */
export function IdentityBar(props: { status: AssistantStatusView }) {
  const { status } = props;
  const reaction = useApp((s) => s.assistantReaction);
  const glance = glanceOf(status);
  const face = useFaceMood(glance, reaction);
  const now = useNow(60_000);
  return (
    <div className="mt-6 flex items-center gap-3 rounded-xl bg-raised p-3 shadow-panel">
      <Avatar spec={glance.character.avatar} name={glance.name} mood={face.mood} burst={face.burst} size={44} stage look />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{glance.name}</p>
        <p className="truncate text-xs text-muted">{openingLine(glance, now)}</p>
      </div>
    </div>
  );
}

/** Round numbers and anniversaries, newest first, as plain facts: what the two of you have been through. */
export function History(props: { status: AssistantStatusView }) {
  const now = useNow(60_000);
  const { bond, profile } = props.status;
  if (!profile.character.showBond) return null;
  const marks = [...bond.milestones].filter((m) => m.at <= now).reverse().slice(0, 6);
  return (
    <Section title="Our history">
      {marks.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted">Nothing yet. It starts with the first thing you tell it to keep.</p>
      ) : (
        <ol className="divide-y divide-line">
          {marks.map((m) => (
            <li key={m.id} className="flex items-baseline gap-3 px-4 py-2.5">
              <span className="w-24 shrink-0 text-xs text-subtle tabular-nums" title={day(m.at)}>{ago(m.at, now)}</span>
              <span className="min-w-0 text-sm text-fg">{milestoneText(m.id)}</span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

/** The standing rules it follows, in the words you gave them: what it knows about how you work, where you can see it. */
export function Rules(props: { bump: number; onMemory: () => void }) {
  const rules = useAssistantData<MemoryListView>("/memories?status=active&kind=constraint&limit=4", props.bump);
  if (!rules.data || rules.data.items.length === 0) return null;
  return (
    <Section title="Rules it follows">
      <ul className="divide-y divide-line">
        {rules.data.items.map((r) => (
          <li key={r.id} className="px-4 py-2.5 text-sm text-fg [overflow-wrap:anywhere]">{r.text}</li>
        ))}
      </ul>
      <div className="border-t border-line px-4 py-2">
        <Button size="xs" variant="ghost" onClick={props.onMemory}>
          See everything it remembers{rules.data.total > rules.data.items.length ? ` (${rules.data.total} rules)` : ""}
        </Button>
      </div>
    </Section>
  );
}
