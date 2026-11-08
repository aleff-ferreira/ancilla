import { useEffect, useRef, useState } from "react";
import { useApp, useController } from "../../app/context.js";
import { errorMessage } from "../../client.js";
import type { AssistantCharacterView, AssistantProfileView, CharacterPresence } from "../../types.js";
import { Section, Pick, Row } from "../settings/SettingsPage.js";
import { Toggle } from "../ui/primitives.js";
import { useAssistantCall } from "./api.js";
import { mergeChange, mergeCharacter, tidyQuirks, type CharacterChange } from "./companion/draft.js";
import { LookEditor, Preview, VoiceEditor } from "./companion/edit.js";
import { greeting } from "./companion/voice.js";
import { Notice, TextField } from "./parts.js";

interface Settings {
  name: string;
  persona: string;
  character: AssistantCharacterView;
  communication: AssistantProfileView["communication"];
}

interface Patch {
  name?: string;
  persona?: string;
  character?: CharacterChange;
  communication?: Partial<AssistantProfileView["communication"]>;
}

const SAVE_AFTER_MS = 450;

/**
 * What the user is editing, as they edit it: every change shows at once on the preview and is saved a moment after the
 * last one, as one request, so dragging a dial is one write and a refused change puts the page back as the server has it.
 */
function useSettings(profile: AssistantProfileView, changed: () => void) {
  const call = useAssistantCall();
  const [draft, setDraft] = useState<Settings>(() => ({ name: profile.name, persona: profile.persona, character: profile.character, communication: profile.communication }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stamp = useRef(profile.updatedAt);
  const queued = useRef<Patch>({});
  const timer = useRef<number | null>(null);

  const flush = async () => {
    timer.current = null;
    const patch = queued.current;
    queued.current = {};
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { ...patch, expectedUpdatedAt: stamp.current };
      if (patch.character?.quirks) body["character"] = { ...patch.character, quirks: tidyQuirks(patch.character.quirks) };
      const out = await call<{ profile?: AssistantProfileView }>("PATCH", "/profile", body);
      if (out?.profile) stamp.current = out.profile.updatedAt;
    } catch (e) {
      setError(errorMessage(e));
      stamp.current = -1;
    } finally {
      setSaving(false);
      changed();
    }
  };

  // The server's own answer wins once nothing of ours is waiting: after a save, a refusal, or a change made elsewhere.
  useEffect(() => {
    if (timer.current !== null || saving || Object.keys(queued.current).length > 0) return;
    if (profile.updatedAt === stamp.current && !error) return;
    stamp.current = profile.updatedAt;
    setDraft({ name: profile.name, persona: profile.persona, character: profile.character, communication: profile.communication });
  }, [profile, saving, error]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const update = (patch: Patch) => {
    setDraft((d) => ({
      name: patch.name ?? d.name,
      persona: patch.persona ?? d.persona,
      character: patch.character ? mergeCharacter(d.character, patch.character) : d.character,
      communication: patch.communication ? { ...d.communication, ...patch.communication } : d.communication,
    }));
    const q = queued.current;
    queued.current = {
      ...q,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.persona !== undefined ? { persona: patch.persona } : {}),
      ...(patch.character ? { character: q.character ? mergeChange(q.character, patch.character) : patch.character } : {}),
      ...(patch.communication ? { communication: { ...(q.communication ?? {}), ...patch.communication } } : {}),
    };
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_AFTER_MS);
  };

  return { draft, update, saving, error };
}

/** Who the assistant is: a name, a face, a voice, habits, and how much of all that reaches a prompt. It is saved as you go. */
export function PersonaPanel(props: { profile: AssistantProfileView; changed: () => void }) {
  const controller = useController();
  const presence = useApp((s) => s.prefs.assistantPresence);
  const invite = useApp((s) => s.prefs.assistantInvite);
  const { draft, update, saving, error } = useSettings(props.profile, props.changed);
  const c = draft.character;
  const name = draft.name.trim() || "Ancilla";
  return (
    <div>
      {/* It follows you down the page, so a change made far from it still shows on it, when the window is tall enough to spare the room. */}
      <div className="z-10 mt-6 [@media(min-height:760px)]:sticky [@media(min-height:760px)]:top-2">
        <Preview draft={c} name={name} line={greeting(c, { name }, Date.now())} />
      </div>
      <p className="mt-2 h-4 text-right text-2xs text-subtle" role="status">{saving ? "Saving..." : error ? "" : "Saved as you go"}</p>
      {error ? <Notice tone="error">{error}</Notice> : null}

      <Section title="Name">
        <Row label="Name" description="What it calls itself, and how the model is told to think of it.">
          <TextField value={draft.name} label="Name" maxLength={60} onCommit={(value) => update({ name: value || "Ancilla" })} className="w-full @min-[520px]:w-64" />
        </Row>
        <Row label="In your own words" description="Anything about it the voice and the dials do not say. It is added to every prompt, so keep it short.">
          <TextField value={draft.persona} label="Character" multiline maxLength={1000} onCommit={(persona) => update({ persona })} className="w-full @min-[520px]:w-96" />
        </Row>
      </Section>

      <Section title="Look">
        <div className="px-4 pb-4">
          <LookEditor draft={c} onChange={(change) => update({ character: change })} />
        </div>
      </Section>

      <Section title="Voice">
        <div className="px-4 pb-4">
          <VoiceEditor draft={c} name={name} onChange={(change) => update({ character: change })} />
        </div>
      </Section>

      <Section title="Replies in threads">
        <Row label="Tone">
          <Pick value={draft.communication.tone} options={[{ value: "plain", label: "Plain" }, { value: "warm", label: "Warm" }, { value: "formal", label: "Formal" }]} onChange={(tone) => update({ communication: { tone } })} />
        </Row>
        <Row label="Length">
          <Pick value={draft.communication.verbosity} options={[{ value: "concise", label: "Short" }, { value: "balanced", label: "Balanced" }, { value: "detailed", label: "Detailed" }]} onChange={(verbosity) => update({ communication: { verbosity } })} />
        </Row>
        <Row label="Language" description="Leave empty to follow the language you write in.">
          <TextField value={draft.communication.language} label="Language" maxLength={40} placeholder="Portuguese" onCommit={(language) => update({ communication: { language } })} className="w-full @min-[520px]:w-48" />
        </Row>
        <Row label="Anything else about how to talk to you">
          <TextField value={draft.communication.notes} label="Notes on how to talk to you" multiline maxLength={600} onCommit={(notes) => update({ communication: { notes } })} className="w-full @min-[520px]:w-96" />
        </Row>
      </Section>

      <Section title="Where it shows up">
        <Row label="In what Muse is told" description="Off keeps the voice to this page and Ancilla's own words. A line of tone adds one line to each prompt. The whole character adds the voice, the dials, what it calls you and the habits.">
          <Pick<CharacterPresence>
            value={c.presence}
            options={[{ value: "off", label: "Off", hint: "Only in Ancilla's words" }, { value: "tone", label: "A line of tone", hint: "One line in each prompt" }, { value: "full", label: "The whole character", hint: "Voice, dials, name, habits" }]}
            onChange={(value) => update({ character: { presence: value } })}
          />
        </Row>
        <Row label="Its face beside the composer" description="It works while a turn runs, wants you when something waits, and is pleased when it finishes.">
          <Toggle checked={presence} label="Show its face beside the composer" onChange={(on) => controller.setPrefs({ assistantPresence: on })} />
        </Row>
        <Row label="Our history" description="Days together, what it remembers, what you finished together. Nothing counts days you were away.">
          <Toggle checked={c.showBond} label="Show our history" onChange={(on) => update({ character: { showBond: on } })} />
        </Row>
        <Row label="Its card in the sidebar" description="Off, a small icon in the footer opens this page instead.">
          <Toggle checked={invite !== "hidden"} label="Show its card in the sidebar" onChange={(on) => controller.setPrefs({ assistantInvite: on ? "calm" : "hidden" })} />
        </Row>
      </Section>

      <p className="mt-6 text-xs text-muted text-pretty">
        It is an AI assistant. The character changes how it looks and sounds, never what it may do and never what is true, and it will say what it is if you ask. Nothing here gives it permission: that is in Settings and in Muse&apos;s approvals.
      </p>
    </div>
  );
}
