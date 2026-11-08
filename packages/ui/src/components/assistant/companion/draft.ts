import type { AssistantCharacterView } from "../../../types.js";

/** What a control may change about the character: some of the face, some of the voice, what it calls you, its habits, where it shows up. */
export interface CharacterChange {
  avatar?: Partial<AssistantCharacterView["avatar"]>;
  voice?: Partial<AssistantCharacterView["voice"]>;
  callsUser?: string;
  quirks?: string[];
  presence?: AssistantCharacterView["presence"];
  showBond?: boolean;
}

/** The character with a change laid over it: the face and the voice field by field, everything else replaced. */
export function mergeCharacter(base: AssistantCharacterView, change: CharacterChange): AssistantCharacterView {
  const { avatar, voice, ...rest } = change;
  return { ...base, ...rest, avatar: { ...base.avatar, ...(avatar ?? {}) }, voice: { ...base.voice, ...(voice ?? {}) } };
}

/** Two changes in a row as one: what was asked later wins, field by field. */
export function mergeChange(first: CharacterChange, second: CharacterChange): CharacterChange {
  const { avatar: a2, voice: v2, ...rest2 } = second;
  const { avatar: a1, voice: v1, ...rest1 } = first;
  const out: CharacterChange = { ...rest1, ...rest2 };
  if (a1 || a2) out.avatar = { ...(a1 ?? {}), ...(a2 ?? {}) };
  if (v1 || v2) out.voice = { ...(v1 ?? {}), ...(v2 ?? {}) };
  return out;
}

/** A habit the user left empty is not a habit: the server drops it too, and the draft should not count it. */
export function tidyQuirks(quirks: readonly string[]): string[] {
  return quirks.map((q) => q.trim()).filter((q) => q !== "").slice(0, 4);
}
