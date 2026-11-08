import { useCallback, useEffect, useState } from "react";
import { useController } from "../../app/context.js";
import { callIsLive, closeCall, readVoiceStatus, startCall, useCallSession } from "./call.js";
import { wantAssistantTab } from "./nav.js";
import { warmVoice } from "./warm.js";

/**
 * "Talk to the assistant", for every place that offers it. Whether the voice is installed is read once and kept for a
 * little while, so that a click can start the call at once: the browser lets the microphone and the sound start only from
 * the click itself, and a call that waited for an answer first might lose that.
 */

const KNOWN_FOR_MS = 20_000;
let known: { at: number; available: boolean; mode: "hands-free" | "push-to-talk" } | null = null;

/** Whether a call can be made: true or false once it is known, null before. */
export function useVoiceAvailable(): boolean | null {
  const controller = useController();
  const [available, setAvailable] = useState<boolean | null>(known ? known.available : null);
  useEffect(() => {
    if (!controller.hasVoice) {
      setAvailable(false);
      return undefined;
    }
    if (known && Date.now() - known.at < KNOWN_FOR_MS) {
      setAvailable(known.available);
      return undefined;
    }
    let cancelled = false;
    void readVoiceStatus(controller).then((status) => {
      if (cancelled) return;
      known = status ? { at: Date.now(), available: status.available, mode: status.settings.mode } : null;
      setAvailable(status ? status.available : false);
    });
    return () => {
      cancelled = true;
    };
  }, [controller]);
  return available;
}

/** Forgets what was read about the install, for after it changed. */
export function forgetVoiceStatus(): void {
  known = null;
}

/** The click on "Talk": starts a call, or takes the person to where the voice is installed when it is not. `warm` is for the moment before it: a pointer over the button, or the focus on it. */
export function useTalk(): { talk: () => void; warm: () => void; live: boolean; available: boolean | null } {
  const controller = useController();
  const session = useCallSession();
  const available = useVoiceAvailable();
  const live = callIsLive(session);
  const warm = useCallback(() => {
    if (!live) warmVoice(controller, available);
  }, [controller, live, available]);
  const talk = useCallback(() => {
    if (live) {
      closeCall();
      return;
    }
    if (!controller.hasVoice) return;
    if (available === false) {
      wantAssistantTab("voice");
      controller.navigate({ kind: "assistant" });
      return;
    }
    startCall(controller, { mode: known?.mode ?? "hands-free" });
  }, [controller, live, available]);
  return { talk, warm, live, available };
}
