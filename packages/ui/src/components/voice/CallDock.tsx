import { useEffect, useRef, useState } from "react";
import { useApp, useController } from "../../app/context.js";
import { phaseLabel, type CallLine, type CallView } from "../../model/voice/callState.js";
import type { CallSession } from "../../model/voice/session.js";
import { Avatar } from "../assistant/companion/Avatar.js";
import type { AvatarMood } from "../assistant/companion/faces.js";
import { KeyboardIcon, MicrophoneIcon, MicrophoneSlashIcon, PaperPlaneRightIcon, PhoneDisconnectIcon, StopCircleIcon, WaveformIcon, XIcon } from "../ui/icons.js";
import { IconButton, cn } from "../ui/primitives.js";
import { callIsLive, closeCall, useCallSession, useCallView } from "./call.js";
import { wantAssistantTab } from "./nav.js";

/**
 * The call, as a card that floats in the corner while the person goes on using the app. It shows the assistant's face
 * (which moves with the sound of the voice on either side), what is being said as it is said, the tasks working in the
 * background, and the few controls a call needs. It never blocks the page behind it: a call is something the person does
 * while they work, and what they work on is where the assistant's tasks show up.
 */
export function CallDock() {
  const session = useCallSession();
  const view = useCallView(session);
  if (!session || !view) return null;
  return <Card session={session} view={view} />;
}

function moodOf(view: CallView): AvatarMood {
  if (view.status === "failed") return "concern";
  if (view.status !== "ready") return "idle";
  if (view.tasks.some((t) => t.status === "blocked" || t.status === "paused")) return "attention";
  return view.phase === "thinking" ? "working" : "idle";
}

function Card(props: { session: CallSession; view: CallView }) {
  const { session, view } = props;
  const controller = useController();
  const glance = useApp((s) => s.assistantGlance);
  const live = callIsLive(session);
  const [expanded, setExpanded] = useState(false);
  const ring = useRing(session, live);
  const last = view.metrics[view.metrics.length - 1];
  const taskLine = view.tasks.find((t) => t.status === "running" || t.status === "queued");

  // Space is the talk button in push-to-talk mode, as long as the person is not typing somewhere.
  useEffect(() => {
    if (!live || view.mode !== "push-to-talk") return undefined;
    const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || typing(event.target)) return;
      event.preventDefault();
      session.talk(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      session.talk(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [live, session, view.mode]);

  const name = glance?.name ?? "Assistant";
  const status = view.error ?? view.notice?.text ?? null;

  return (
    <section
      aria-label={`Call with ${name}`}
      className={cn(
        "fixed right-4 bottom-4 z-[var(--z-toast)] flex flex-col overflow-hidden rounded-2xl bg-raised shadow-panel ring-1 ring-line",
        expanded ? "h-[min(640px,calc(100vh-32px))] w-[min(440px,calc(100vw-32px))]" : "w-[min(360px,calc(100vw-32px))]",
      )}
    >
      <header className="flex items-center gap-3 px-4 pt-4 pb-2">
        <div ref={ring} className="call-ring relative shrink-0" data-live={live ? "" : undefined} data-who={view.phase === "speaking" && !view.ducked ? "voice" : view.heard ? "mic" : "none"}>
          {glance ? <Avatar spec={glance.character.avatar} name={name} mood={moodOf(view)} size={64} stage /> : <span className="block size-16 rounded-full bg-sunken" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-fg">{name}</div>
          <div className="truncate text-xs text-muted" role="status" aria-live="polite">
            {phaseLabel(view)}
            {live && view.status === "ready" && last?.firstAudioMs != null ? <span className="text-subtle"> · replied in {(last.firstAudioMs / 1000).toFixed(1)} s</span> : null}
          </div>
          {taskLine ? <div className="mt-0.5 truncate text-2xs text-subtle">Working on: {taskLine.title}</div> : null}
        </div>
        <IconButton label={expanded ? "Smaller" : "Larger"} size="sm" onClick={() => setExpanded((v) => !v)}>
          <WaveformIcon size={14} />
        </IconButton>
        {!live ? (
          <IconButton label="Close" size="sm" onClick={() => closeCall()}>
            <XIcon size={14} />
          </IconButton>
        ) : null}
      </header>

      {status ? <p className={cn("mx-4 mb-1 rounded-md px-2 py-1.5 text-xs", view.error || view.notice?.level === "warn" ? "bg-warn-soft text-warn-text" : "bg-sunken text-muted")}>{status}</p> : null}
      {view.micProblem ? <p className="mx-4 mb-1 rounded-md bg-warn-soft px-2 py-1.5 text-xs text-warn-text">{view.micProblem}</p> : null}
      {view.status === "failed" && view.error?.includes("not installed") ? <p className="mx-4 mb-1 text-xs text-muted">Open Assistant, then Voice, to install it.</p> : null}

      <Transcript view={view} tall={expanded} />

      {view.tasks.length > 0 ? (
        <ul className="mx-4 mb-2 flex flex-wrap gap-1.5">
          {view.tasks.slice(0, 4).map((t) => (
            <li key={t.id} title={t.note ?? t.title} className="inline-flex max-w-full items-center gap-1 rounded-md bg-sunken px-1.5 py-0.5 text-2xs text-muted">
              <span className={cn("size-1.5 shrink-0 rounded-full", t.status === "completed" ? "bg-ok-text" : t.status === "failed" ? "bg-danger-text" : t.status === "blocked" || t.status === "paused" ? "bg-warn-text" : "bg-accent")} />
              <span className="truncate">{t.title}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {live ? (
        <Controls session={session} view={view} />
      ) : (
        <Ended
          view={view}
          onClose={() => closeCall()}
          onAgain={() => {
            wantAssistantTab("voice");
            controller.navigate({ kind: "assistant" });
            closeCall();
          }}
        />
      )}
    </section>
  );
}

/** The lines of the conversation, newest at the bottom, and the words being said now. */
function Transcript(props: { view: CallView; tall: boolean }) {
  const { view } = props;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.lines, view.partial]);
  const lines = props.tall ? view.lines : view.lines.slice(-4);
  return (
    <div ref={box} className={cn("mx-4 mb-2 min-h-[56px] flex-1 space-y-1.5 overflow-y-auto text-sm", props.tall ? "" : "max-h-[200px]")}>
      {lines.length === 0 && view.partial === "" ? <p className="text-xs text-subtle">{view.status === "ready" ? (view.resumed ? "Back where you left off. Say something." : "Say something, or type below.") : "…"}</p> : null}
      {lines.map((line, i) => (
        <Line key={`${line.turn}-${line.role}-${i}`} line={line} />
      ))}
      {view.partial !== "" ? <p className="text-fg/70 italic">{view.partial}</p> : null}
    </div>
  );
}

function Line(props: { line: CallLine }) {
  const { line } = props;
  const mine = line.role === "user";
  return (
    <p className={cn("leading-snug", mine ? "text-muted" : "text-fg")}>
      <span className="mr-1.5 text-2xs font-medium tracking-wide text-subtle uppercase">{mine ? "You" : "It"}</span>
      {line.interrupted && line.heard !== null ? (
        <>
          {line.heard.trim() === "" ? <span className="text-subtle">(cut off)</span> : line.heard}
          <span className="text-subtle"> …</span>
        </>
      ) : (
        line.text
      )}
      {!line.done ? <span className="text-subtle"> …</span> : null}
    </p>
  );
}

function Controls(props: { session: CallSession; view: CallView }) {
  const { session, view } = props;
  const [text, setText] = useState("");
  const [typing, setTyping] = useState(false);
  const send = () => {
    session.sendText(text);
    setText("");
  };
  const pushToTalk = view.mode === "push-to-talk";
  return (
    <footer className="border-t border-line px-3 py-2.5">
      {typing ? (
        <form
          className="mb-2 flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <input
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Type instead…"
            maxLength={4000}
            aria-label="Type a message to the assistant"
            className="h-8 min-w-0 flex-1 rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus"
          />
          <IconButton label="Send" size="md" disabled={text.trim() === ""} type="submit">
            <PaperPlaneRightIcon size={15} />
          </IconButton>
        </form>
      ) : null}
      <div className="flex items-center gap-1.5">
        <IconButton label={view.muted ? "Unmute the microphone" : "Mute the microphone"} size="md" active={view.muted} onClick={() => session.setMuted(!view.muted)}>
          {view.muted ? <MicrophoneSlashIcon size={16} /> : <MicrophoneIcon size={16} />}
        </IconButton>
        <IconButton label={typing ? "Hide the keyboard" : "Type instead"} size="md" active={typing} onClick={() => setTyping((v) => !v)}>
          <KeyboardIcon size={16} />
        </IconButton>
        <IconButton
          label={pushToTalk ? "Push to talk is on: switch to hands-free" : "Hands-free is on: switch to push to talk"}
          size="md"
          active={pushToTalk}
          onClick={() => session.setMode(pushToTalk ? "hands-free" : "push-to-talk")}
        >
          <span className="text-2xs font-semibold">{pushToTalk ? "PTT" : "AUTO"}</span>
        </IconButton>
        {pushToTalk ? (
          <button
            type="button"
            className={cn("h-8 rounded-lg px-3 text-xs font-medium transition-colors", view.talking ? "bg-accent text-accent-fg" : "bg-sunken text-muted hover:bg-hover")}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              session.talk(true);
            }}
            onPointerUp={() => session.talk(false)}
            onPointerCancel={() => session.talk(false)}
          >
            Hold to talk
          </button>
        ) : null}
        <span className="flex-1" />
        {view.phase === "speaking" ? (
          <IconButton label="Stop talking" size="md" onClick={() => session.interrupt()}>
            <StopCircleIcon size={17} />
          </IconButton>
        ) : null}
        <IconButton label="End the call" size="md" className="bg-danger-soft text-danger-text hover:opacity-80" onClick={() => session.end()}>
          <PhoneDisconnectIcon size={17} />
        </IconButton>
      </div>
    </footer>
  );
}

function Ended(props: { view: CallView; onClose: () => void; onAgain: () => void }) {
  const { view } = props;
  return (
    <footer className="flex items-center gap-2 border-t border-line px-4 py-3">
      <p className="min-w-0 flex-1 truncate text-xs text-muted">{view.status === "failed" ? "The call did not start." : view.endedReason ?? "The call ended."}</p>
      {view.status === "failed" ? (
        <button type="button" className="rounded-md px-2 py-1 text-xs font-medium text-accent-text hover:bg-hover" onClick={props.onAgain}>
          Voice settings
        </button>
      ) : null}
      <button type="button" className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-hover hover:text-fg" onClick={props.onClose}>
        Close
      </button>
    </footer>
  );
}

/** Moves the face's ring with the sound on the line: the microphone's level and the voice's, polled once a frame. */
function useRing(session: CallSession, live: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !live || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined;
    let frame = 0;
    let mic = 0;
    let voice = 0;
    const tick = () => {
      const now = session.levels();
      mic += (now.mic - mic) * 0.35;
      voice += (now.voice - voice) * 0.35;
      el.style.setProperty("--mic", mic.toFixed(3));
      el.style.setProperty("--voice", voice.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [session, live]);
  return ref;
}
