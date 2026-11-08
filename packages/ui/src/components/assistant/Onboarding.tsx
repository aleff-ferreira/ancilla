import { useState } from "react";
import { errorMessage } from "../../client.js";
import type { AssistantAutonomy, AssistantCharacterView, AssistantProfileView } from "../../types.js";
import { Pick } from "../settings/SettingsPage.js";
import { Button } from "../ui/primitives.js";
import { useAssistantCall } from "./api.js";
import { Avatar } from "./companion/Avatar.js";
import { mergeCharacter, tidyQuirks, type CharacterChange } from "./companion/draft.js";
import { LookEditor, Preview, VoiceEditor } from "./companion/edit.js";
import { greeting, say } from "./companion/voice.js";
import { Notice } from "./parts.js";

const STEPS = ["Hello", "Look", "Voice", "Wake it"] as const;

const AUTONOMY: { value: AssistantAutonomy; label: string; hint: string }[] = [
  { value: "ask", label: "Ask first", hint: "Starts nothing. Only says what is waiting on you." },
  { value: "suggest", label: "Suggest", hint: "Lists the work it could do, with why. You start it." },
  { value: "act", label: "Act within limits", hint: "Starts work that only reads and rests on something you said, a couple a day at most." },
];

/**
 * The first meeting: a name, a face, a voice and what it may do alone, one step at a time, with the assistant in front of
 * you changing as you choose. Nothing is saved, and nothing is switched on, until the last step, so leaving half way
 * leaves everything as it was. It is also how an assistant that was switched on before it had a face gets one.
 */
export function Onboarding(props: { profile: AssistantProfileView; onDone: () => void; onCancel?: () => void }) {
  const call = useAssistantCall();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(props.profile.name || "Ancilla");
  const [character, setCharacter] = useState<AssistantCharacterView>(props.profile.character);
  const [autonomy, setAutonomy] = useState<AssistantAutonomy>(props.profile.autonomy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = name.trim() || "Ancilla";
  const change = (patch: CharacterChange) => setCharacter((c) => mergeCharacter(c, patch));

  const wake = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("PATCH", "/profile", {
        enabled: true,
        name: shown,
        autonomy,
        character: { avatar: character.avatar, voice: character.voice, callsUser: character.callsUser, quirks: tidyQuirks(character.quirks), presence: character.presence, showBond: character.showBond, configured: true },
        expectedUpdatedAt: props.profile.updatedAt,
      });
      props.onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="mt-6" data-step={step}>
      <ol className="mb-5 flex items-center gap-2" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2" aria-current={i === step ? "step" : undefined}>
            <span className={`flex h-6 items-center rounded-full px-2.5 text-2xs font-medium ${i === step ? "bg-accent-soft text-accent-text" : i < step ? "text-fg" : "text-subtle"}`}>
              {i + 1}. {label}
            </span>
            {i < STEPS.length - 1 ? <span className="h-px w-4 bg-line" aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <section className="companion-hello rounded-2xl bg-raised p-6 shadow-panel @min-[560px]:p-8" aria-label="Hello">
          <div className="flex flex-col items-center gap-6 text-center @min-[560px]:flex-row @min-[560px]:items-center @min-[560px]:text-left">
            <div className="companion-assemble ch-stage rounded-2xl" style={{ ["--h" as string]: character.avatar.hue, ["--g" as string]: (character.avatar.glow / 100).toFixed(2) }}>
              <Avatar spec={character.avatar} name={shown} size={168} look />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-3xl leading-9 tracking-[-0.015em] text-fg">Meet your assistant</h2>
              <p className="mt-2 text-sm leading-6 text-muted text-pretty">
                It remembers what you tell it, in your own words, and says so when it is unsure. It works on what you approve, and finishes a task as done only when something it can read confirms it. Give it a face and a voice, and it is yours: nothing is kept or switched on until the last step.
              </p>
              <label className="mt-4 block text-sm font-medium text-fg" htmlFor="companion-name">What should it be called?</label>
              <input
                id="companion-name"
                type="text"
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                className="mt-1.5 h-10 w-full max-w-72 rounded-lg bg-sunken px-3 text-base text-fg shadow-[0_0_0_1px_var(--border)] outline-none focus-visible:ring-2 focus-visible:ring-focus"
              />
            </div>
          </div>
        </section>
      ) : (
        <div className="grid gap-5 @min-[760px]:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
          <div className="@min-[760px]:sticky @min-[760px]:top-2 @min-[760px]:self-start">
            <Preview draft={character} name={shown} size={132} line={step === 3 ? say("hello", character, { name: shown }, Date.now()) : greeting(character, { name: shown }, Date.now())} />
          </div>
          <div className="min-w-0 rounded-2xl bg-raised p-4 shadow-panel @min-[560px]:p-5">
            {step === 1 ? <LookEditor draft={character} onChange={change} /> : null}
            {step === 2 ? <VoiceEditor draft={character} name={shown} onChange={change} /> : null}
            {step === 3 ? (
              <div>
                <h3 className="text-base font-semibold text-fg">Before it wakes</h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                  <li>It reads what you type in threads for things worth keeping, and puts the notes that apply in front of your messages. It makes no model call of its own.</li>
                  <li>Notes live in assistant.db in Ancilla&apos;s data folder, with the exact words each came from. Passwords, keys and ID numbers are never kept.</li>
                  <li>You can read, correct, pin, export and erase any note, pause remembering, or switch it all off.</li>
                  <li>It is an AI assistant. The character changes how it sounds, never what it may do or what is true.</li>
                </ul>
                <p className="mt-4 text-sm font-medium text-fg">How much may it do on its own?</p>
                <p className="mt-0.5 text-xs text-muted">Memory never grants permission: this setting does, and Muse&apos;s approvals still apply.</p>
                <div className="mt-2">
                  <Pick<AssistantAutonomy> value={autonomy} options={AUTONOMY} onChange={setAutonomy} />
                </div>
                {error ? <div className="mt-3"><Notice tone="error">{error}</Notice></div> : null}
              </div>
            ) : null}
          </div>
        </div>
      )}

      <div className="mt-5 flex items-center justify-between gap-3">
        <div>
          {step > 0 ? (
            <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={busy}>
              Back
            </Button>
          ) : props.onCancel ? (
            <Button variant="ghost" onClick={props.onCancel}>
              Not now
            </Button>
          ) : null}
        </div>
        {step < STEPS.length - 1 ? (
          <Button variant="accent" onClick={() => setStep(step + 1)} disabled={step === 0 && !shown}>
            {step === 0 ? "Let's begin" : "Next"}
          </Button>
        ) : (
          <Button variant="accent" onClick={() => void wake()} loading={busy}>
            Wake {shown}
          </Button>
        )}
      </div>
    </div>
  );
}
