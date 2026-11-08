import { useEffect, useRef, useState } from "react";
import { useApp } from "../../../app/context.js";
import type { ThreadFold } from "../../../model/fold.js";
import { Avatar } from "./Avatar.js";
import type { AvatarMood } from "./avatar.js";
import { say, type LineKind } from "./voice.js";

type Flash = { kind: "start" | "done" | "failed"; at: number };

/** How a thread's last turn ended, in the three ways the face reacts to: it finished, it failed, or it was stopped (which is no occasion). */
export function lastOutcome(fold: ThreadFold | null): "completed" | "failed" | "stopped" | null {
  if (!fold) return null;
  let last: { at: number; terminal?: string } | null = null;
  for (const turn of Object.values(fold.turns)) {
    const at = turn.completedAt ?? turn.startedAt ?? 0;
    if (turn.terminal && (!last || at >= last.at)) last = { at, terminal: turn.terminal };
  }
  if (!last?.terminal) return null;
  if (last.terminal === "completed") return "completed";
  return last.terminal === "failed" || last.terminal === "error" ? "failed" : "stopped";
}

/**
 * The assistant's face beside the composer, which reacts to the thread in front of it: at work while a turn runs, wanting
 * you when something waits on an answer, pleased when it finishes, concerned when it fails, with a line in its voice that
 * stays a few seconds. It says nothing the run card does not, and it is the one place where the assistant is simply there,
 * the way a companion is. The user can switch it off in Settings.
 */
export function ThreadPresence(props: { fold: ThreadFold | null; running: boolean; waiting: number }) {
  const glance = useApp((s) => s.assistantGlance);
  const wanted = useApp((s) => s.prefs.assistantPresence);
  const [flash, setFlash] = useState<Flash | null>(null);
  const was = useRef(props.running);
  useEffect(() => {
    const before = was.current;
    if (before === props.running) return;
    was.current = props.running;
    if (props.running) {
      setFlash({ kind: "start", at: Date.now() });
      return;
    }
    const outcome = lastOutcome(props.fold);
    setFlash(outcome === "completed" ? { kind: "done", at: Date.now() } : outcome === "failed" ? { kind: "failed", at: Date.now() } : null);
  }, [props.running, props.fold]);
  useEffect(() => {
    if (!flash) return undefined;
    const timer = window.setTimeout(() => setFlash(null), flash.kind === "start" ? 2800 : 4600);
    return () => window.clearTimeout(timer);
  }, [flash]);

  if (!glance || !wanted || !glance.enabled || glance.character.setupAt === null) return null;
  const mood: AvatarMood = props.waiting > 0 ? "attention" : props.running ? "working" : flash?.kind === "done" ? "delight" : flash?.kind === "failed" ? "concern" : "idle";
  const kind: LineKind | null = props.waiting > 0 ? "threadNeeds" : flash?.kind === "start" ? "threadWorking" : flash?.kind === "done" ? "threadDone" : flash?.kind === "failed" ? "threadFailed" : null;
  const line = kind ? say(kind, glance.character, { name: glance.name }, flash?.at ?? 0) : null;
  return (
    <span className="relative inline-flex shrink-0 items-center" data-presence={mood}>
      <Avatar spec={glance.character.avatar} name={glance.name} mood={mood} burst={flash?.at ?? 0} size={26} stage look />
      {line ? (
        <span role="status" className="presence-bubble">
          {line}
        </span>
      ) : null}
    </span>
  );
}
