import { useSyncExternalStore } from "react";
import type { AncillaController } from "../../model/controller.js";
import type { CallView } from "../../model/voice/callState.js";
import { browserCallIO } from "../../model/voice/browser.js";
import type { CallMode } from "../../model/voice/protocol.js";
import { CallSession } from "../../model/voice/session.js";
import type { VoiceStatusView } from "../../types.js";

/**
 * The one call the page may have. It lives outside any component so that it goes on while the person moves between
 * pages (a call to the assistant is not a screen, it is something the app is doing), and the dock that shows it can be
 * mounted anywhere.
 */

let active: CallSession | null = null;
const watchers = new Set<() => void>();

function notify(): void {
  for (const watcher of [...watchers]) watcher();
}

function watch(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/** The call in progress, or the one that just ended and is still on screen; null when there is none. */
export function useCallSession(): CallSession | null {
  return useSyncExternalStore(watch, () => active, () => null);
}

const IDLE_VIEW: CallView | null = null;

/** What the call shows now, kept current as the server speaks. */
export function useCallView(session: CallSession | null): CallView | null {
  return useSyncExternalStore(
    (listener) => (session ? session.subscribe(listener) : () => undefined),
    () => (session ? session.view : IDLE_VIEW),
    () => IDLE_VIEW,
  );
}

export function callIsLive(session: CallSession | null): boolean {
  const status = session?.view.status;
  return status === "connecting" || status === "ready";
}

export interface TalkOptions {
  mode?: CallMode;
  project?: string | null;
}

/** Starts a call. Does nothing when one is already live. Must be called from the click that asked for it: the browser ties the microphone prompt and the audio to that gesture. */
export function startCall(controller: AncillaController, options: TalkOptions = {}): CallSession {
  if (active && callIsLive(active)) return active;
  const io = browserCallIO(() => controller.voiceSocketUrl());
  const session = new CallSession(io, { mode: options.mode ?? "hands-free", lang: null, project: options.project ?? null });
  active = session;
  notify();
  void session.start();
  return session;
}

/** Hangs up if the call is live, and takes it off the screen. */
export function closeCall(): void {
  const session = active;
  active = null;
  if (session && callIsLive(session)) session.end();
  notify();
}

/** Reads the voice's status, for the places that decide whether a call can be made. */
export async function readVoiceStatus(controller: AncillaController): Promise<VoiceStatusView | null> {
  try {
    return await controller.voice<VoiceStatusView>("GET", "");
  } catch {
    return null;
  }
}
