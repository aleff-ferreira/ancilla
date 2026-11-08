import { useEffect, useState } from "react";
import type { AssistantGlance } from "../../../model/store.js";
import type { AvatarMood } from "./avatar.js";

/** How long a reaction (a note kept, a refusal, a question) shows on the face before it goes back to what it was doing. */
export const REACTION_MS = 2600;

/** What the assistant is, to the user, at a glance. */
export type CompanionState = "invite" | "off" | "needs" | "working" | "idle";

/** Where it stands: waiting to be set up, switched off, wanting you, at work, or at rest. */
export function stateOf(glance: AssistantGlance): CompanionState {
  if (glance.character.setupAt === null) return "invite";
  if (!glance.enabled) return "off";
  if (glance.needsYou > 0) return "needs";
  if (glance.running > 0) return "working";
  return "idle";
}

export interface FaceMood {
  mood: AvatarMood;
  /** Moves when a brief mood should play again. */
  burst: number;
}

/**
 * The mood on its face now: a reaction while it is fresh, else what it is doing. It sleeps only when it has been set up
 * and switched off: before that it is waiting for its owner, awake.
 */
export function moodNow(glance: AssistantGlance, reaction: { mood: "delight" | "concern" | "attention"; at: number } | null, now: number): FaceMood {
  if (reaction && now - reaction.at < REACTION_MS && glance.enabled) return { mood: reaction.mood, burst: reaction.at };
  switch (stateOf(glance)) {
    case "off": return { mood: "asleep", burst: 0 };
    case "needs": return { mood: "attention", burst: 0 };
    case "working": return { mood: "working", burst: 0 };
    default: return { mood: "idle", burst: 0 };
  }
}

/** The face's mood, kept current: it re-reads the clock once when a reaction runs out. */
export function useFaceMood(glance: AssistantGlance | null, reaction: { mood: "delight" | "concern" | "attention"; at: number } | null): FaceMood {
  const [, tick] = useState(0);
  const at = reaction?.at ?? 0;
  useEffect(() => {
    if (!at) return undefined;
    const left = at + REACTION_MS - Date.now();
    if (left <= 0) return undefined;
    const timer = window.setTimeout(() => tick((n) => n + 1), left + 30);
    return () => window.clearTimeout(timer);
  }, [at]);
  return glance ? moodNow(glance, reaction, Date.now()) : { mood: "idle", burst: 0 };
}
