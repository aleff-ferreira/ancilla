import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useApp, useController } from "../../app/context.js";
import type { AssistantGlance } from "../../model/store.js";
import { emptyLine, phaseLabel, type CallApproval, type CallLine, type CallView } from "../../model/voice/callState.js";
import {
  ASSISTANT_AVATAR_MAX,
  ASSISTANT_AVATAR_MIN,
  AVATAR_SIZE_PRESETS,
  anchorFromRect,
  bubblePlacement,
  cardAvatarSize,
  clampAvatarSize,
  clampFloatingCoords,
  resolveFloatingPosition,
  stepAvatarSize,
  type AssistantAnchor,
  type AssistantWindowMode,
  type BubblePlacement,
} from "../../model/voice/floatingWindow.js";
import type { CallSession } from "../../model/voice/session.js";
import { Avatar } from "../assistant/companion/Avatar.js";
import { chipSub } from "../assistant/companion/CompanionChip.js";
import type { AvatarMood } from "../assistant/companion/faces.js";
import { stateOf, useFaceMood } from "../assistant/companion/mood.js";
import {
  ArrowCounterClockwiseIcon,
  ArrowsOutSimpleIcon,
  ChatCircleDotsIcon,
  DotsSixIcon,
  KeyboardIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  MinusIcon,
  PaperPlaneRightIcon,
  PhoneDisconnectIcon,
  PictureInPictureIcon,
  PlusIcon,
  PushPinIcon,
  PushPinSlashIcon,
  ResizeIcon,
  StopCircleIcon,
  WaveformIcon,
  XIcon,
} from "../ui/icons.js";
import { Tip } from "../ui/overlays.js";
import { IconButton, cn } from "../ui/primitives.js";
import { callIsLive, closeCall, useCallSession, useCallView } from "./call.js";
import { wantAssistantTab } from "./nav.js";
import { useTalk } from "./talk.js";

/**
 * Movable assistant presence and voice call surface.
 *
 * Works in two switchable modes at any spot the person drags it to:
 * - `"float"` (default): the companion avatar floats framelessly in view with a directional caption/approval bubble
 *   and a compact control pill, plus direct avatar size controls (`56 px`–`224 px`).
 * - `"card"`: a movable transcript card with scalable avatar header, full conversation log, and controls.
 *
 * When "Keep floating" (`prefs.assistantFloat`) is switched on, the floating avatar stays on screen between calls so a
 * voice call or size adjustment is always one click away.
 */
export function CallDock() {
  const session = useCallSession();
  const view = useCallView(session);
  const glance = useApp((s) => s.assistantGlance);
  const pinned = useApp((s) => s.prefs.assistantFloat);
  const windowMode = useApp((s) => s.prefs.assistantWindowMode);

  const hasCall = Boolean(session && view);
  const canIdleFloat = Boolean(!hasCall && pinned && glance && glance.enabled && glance.character.setupAt !== null);

  if (!hasCall && !canIdleFloat) return null;

  if (hasCall && windowMode === "card") {
    return <MovableCard session={session!} view={view!} />;
  }
  return <FloatingAssistant session={session} view={view} />;
}

function moodOfCall(view: CallView): AvatarMood {
  if (view.status === "failed") return "concern";
  if (view.status !== "ready") return "idle";
  if (view.approval !== null || view.tasks.some((t) => t.status === "blocked" || t.status === "paused")) return "attention";
  return view.phase === "thinking" ? "working" : "idle";
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("button, input, textarea, select, a, label, [data-no-drag]"));
}

interface MovableSpot {
  boxRef: RefObject<HTMLElement>;
  coords: { left: number; top: number };
  dragging: boolean;
  placement: BubblePlacement;
  onDragPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  resetSpot: () => void;
  hasCustomSpot: boolean;
}

function useMovableSpot(estimatedWidth: number, estimatedHeight: number): MovableSpot {
  const controller = useController();
  const anchor = useApp((s) => s.prefs.assistantPosition);
  const boxRef = useRef<HTMLElement>(null);

  const [viewport, setViewport] = useState(() =>
    typeof window !== "undefined" ? { width: window.innerWidth, height: window.innerHeight } : { width: 1280, height: 800 },
  );
  const [boxSize, setBoxSize] = useState({ width: estimatedWidth, height: estimatedHeight });
  const [dragCoords, setDragCoords] = useState<{ left: number; top: number } | null>(null);
  const suppressClickRef = useRef(false);
  const activeDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setBoxSize((prev) =>
          Math.abs(prev.width - rect.width) < 1 && Math.abs(prev.height - rect.height) < 1
            ? prev
            : { width: Math.round(rect.width), height: Math.round(rect.height) },
        );
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [estimatedWidth, estimatedHeight]);

  const settled = resolveFloatingPosition({
    anchor,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    boxWidth: boxSize.width,
    boxHeight: boxSize.height,
  });
  const coords = dragCoords ?? settled;

  const onDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || isInteractiveTarget(event.target)) return;
      const target = event.currentTarget;
      const startLeft = coords.left;
      const startTop = coords.top;
      const state = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originLeft: startLeft,
        originTop: startTop,
        moved: false,
      };
      activeDragRef.current = state;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic event without capture */
      }

      const onMove = (moveEvent: PointerEvent) => {
        if (activeDragRef.current?.pointerId !== moveEvent.pointerId) return;
        const dx = moveEvent.clientX - state.startX;
        const dy = moveEvent.clientY - state.startY;
        if (!state.moved && Math.hypot(dx, dy) < 6) return;
        state.moved = true;
        const vw = window.innerWidth || viewport.width;
        const vh = window.innerHeight || viewport.height;
        const rect = boxRef.current?.getBoundingClientRect();
        const bw = rect && rect.width > 0 ? rect.width : boxSize.width;
        const bh = rect && rect.height > 0 ? rect.height : boxSize.height;
        setDragCoords(clampFloatingCoords(state.originLeft + dx, state.originTop + dy, vw, vh, bw, bh));
      };

      const finish = (endEvent: PointerEvent) => {
        if (activeDragRef.current?.pointerId !== endEvent.pointerId) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        try {
          if (target.hasPointerCapture?.(endEvent.pointerId)) target.releasePointerCapture(endEvent.pointerId);
        } catch {
          /* already released */
        }
        activeDragRef.current = null;
        if (!state.moved) {
          setDragCoords(null);
          return;
        }
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 80);
        const vw = window.innerWidth || viewport.width;
        const vh = window.innerHeight || viewport.height;
        const rect = boxRef.current?.getBoundingClientRect();
        const bw = rect && rect.width > 0 ? rect.width : boxSize.width;
        const bh = rect && rect.height > 0 ? rect.height : boxSize.height;
        const finalCoords = clampFloatingCoords(
          state.originLeft + (endEvent.clientX - state.startX),
          state.originTop + (endEvent.clientY - state.startY),
          vw,
          vh,
          bw,
          bh,
        );
        const nextAnchor: AssistantAnchor = anchorFromRect(
          { left: finalCoords.left, top: finalCoords.top, width: bw, height: bh },
          vw,
          vh,
        );
        setDragCoords(null);
        controller.setPrefs({ assistantPosition: nextAnchor });
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [coords.left, coords.top, viewport.width, viewport.height, boxSize.width, boxSize.height, controller],
  );

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const resetSpot = useCallback(() => {
    setDragCoords(null);
    controller.setPrefs({ assistantPosition: null });
  }, [controller]);

  const placement = bubblePlacement(
    { left: coords.left, top: coords.top, width: boxSize.width, height: boxSize.height },
    viewport.width,
    viewport.height,
  );

  return {
    boxRef,
    coords,
    dragging: dragCoords !== null,
    placement,
    onDragPointerDown,
    onClickCapture,
    resetSpot,
    hasCustomSpot: anchor !== null,
  };
}

function usePushToTalkSpace(session: CallSession | null, view: CallView | null, live: boolean): void {
  useEffect(() => {
    if (!session || !view || !live || view.mode !== "push-to-talk") return undefined;
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
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
  }, [live, session, view]);
}

function FloatingAssistant(props: { session: CallSession | null; view: CallView | null }) {
  const { session, view } = props;
  const controller = useController();
  const glance = useApp((s) => s.assistantGlance);
  const reaction = useApp((s) => s.assistantReaction);
  const avatarSize = clampAvatarSize(useApp((s) => s.prefs.assistantAvatarSize));
  const pinned = useApp((s) => s.prefs.assistantFloat);
  const idleFace = useFaceMood(glance, reaction);
  const voice = useTalk();

  const live = Boolean(session && callIsLive(session));
  usePushToTalkSpace(session, view, live);

  const [captionsOpen, setCaptionsOpen] = useState(true);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [typingOpen, setTypingOpen] = useState(false);
  const [typedText, setTypedText] = useState("");

  useEffect(() => {
    if (view?.micProblem) setTypingOpen(true);
  }, [view?.micProblem]);

  // Ensure new approvals or errors always surface immediately.
  useEffect(() => {
    if (view?.approval || view?.error) setCaptionsOpen(true);
  }, [view?.approval, view?.error]);

  const spot = useMovableSpot(Math.max(156, avatarSize + 28), avatarSize + 54);
  const ring = useRing(session, live);

  const onAvatarWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if (!event.altKey && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const delta = event.deltaY < 0 ? 1 : event.deltaY > 0 ? -1 : 0;
    if (delta !== 0) {
      controller.setPrefs({ assistantAvatarSize: stepAvatarSize(avatarSize, delta) });
    }
  };

  const name = glance?.name ?? "Assistant";
  const mood: AvatarMood = view ? moodOfCall(view) : idleFace.mood;
  const burst = view ? 0 : idleFace.burst;
  const lastMetric = view?.metrics[view.metrics.length - 1];
  const activeTasks = view?.tasks.filter((t) => t.status === "running" || t.status === "queued" || t.status === "waiting") ?? [];
  const statusText = view ? (view.error ?? view.notice?.text ?? null) : null;
  const hasSpeechLines = Boolean(view && (view.lines.length > 0 || view.partial !== ""));
  const showBubble = Boolean(
    view &&
      ((live && view.approval !== null) ||
        statusText !== null ||
        view.micProblem !== null ||
        (captionsOpen && (hasSpeechLines || activeTasks.length > 0))),
  );

  const sendTyped = () => {
    if (!session || typedText.trim() === "") return;
    session.sendText(typedText);
    setTypedText("");
  };

  const bubblePosClass = cn(
    "pointer-events-auto absolute z-10 flex flex-col gap-2 rounded-2xl bg-raised/94 p-3 shadow-panel ring-1 ring-line-strong/80 backdrop-blur-md",
    spot.placement.side === "left" ? "right-full mr-3" : "left-full ml-3",
    spot.placement.align === "bottom"
      ? "bottom-2"
      : spot.placement.align === "top"
        ? "top-2"
        : "top-1/2 -translate-y-1/2",
  );

  const idleSummary = glance ? chipSub(stateOf(glance), glance.needsYou) : "Ready";

  return (
    <section
      ref={spot.boxRef}
      aria-label={view ? `Call with ${name}` : `${name} floating companion`}
      onClickCapture={spot.onClickCapture}
      style={{ left: spot.coords.left, top: spot.coords.top }}
      className="group/float pointer-events-none fixed z-[var(--z-toast)] flex flex-col items-center select-none"
    >
      {/* Directional speech, status, and authorization bubble */}
      {showBubble && view ? (
        <div style={{ width: spot.placement.maxWidth }} className={bubblePosClass} data-no-drag>
          <div className="flex items-center justify-between gap-2 border-b border-line/55 pb-1.5">
            <div className="flex min-w-0 items-center gap-1.5 text-xs">
              <span className="truncate font-semibold text-fg">{name}</span>
              <span className="truncate text-subtle">· {phaseLabel(view)}</span>
              {live && view.status === "ready" && lastMetric?.firstAudioMs != null ? (
                <span className="shrink-0 text-2xs text-subtle">({(lastMetric.firstAudioMs / 1000).toFixed(1)}s)</span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Tip label="Open full transcript card">
                <IconButton
                  label="Open full transcript card"
                  size="sm"
                  onClick={() => controller.setPrefs({ assistantWindowMode: "card" })}
                >
                  <ArrowsOutSimpleIcon size={13} />
                </IconButton>
              </Tip>
              {!view.approval && !view.error ? (
                <Tip label="Hide speech bubble">
                  <IconButton label="Hide speech bubble" size="sm" onClick={() => setCaptionsOpen(false)}>
                    <MinusIcon size={13} />
                  </IconButton>
                </Tip>
              ) : null}
            </div>
          </div>

          {statusText ? (
            <p
              className={cn(
                "rounded-lg px-2.5 py-1.5 text-xs",
                view.error || view.notice?.level === "warn" ? "bg-warn-soft text-warn-text" : "bg-sunken text-muted",
              )}
            >
              {statusText}
            </p>
          ) : null}
          {view.micProblem ? (
            <p className="rounded-lg bg-warn-soft px-2.5 py-1.5 text-xs text-warn-text">{view.micProblem}</p>
          ) : null}
          {view.status === "failed" && view.error?.includes("not installed") ? (
            <p className="text-xs text-muted">Open Assistant, then Voice, to install it.</p>
          ) : null}

          {live && view.approval && session ? (
            <ApprovalBox approval={view.approval} onDecide={(allow) => session.decide(view.approval!.id, allow)} />
          ) : null}

          {captionsOpen && hasSpeechLines ? <FloatingCaptions view={view} name={name} /> : null}

          {activeTasks.length > 0 ? (
            <div className="flex flex-col gap-1">
              {activeTasks.slice(0, 3).map((t) => (
                <div
                  key={t.id}
                  title={t.note ? `${t.title} — ${t.note}` : t.title}
                  className="flex items-center gap-1.5 truncate rounded-lg border border-line/70 bg-sunken/70 px-2 py-1 text-2xs text-muted"
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-accent" />
                  <span className="truncate">
                    Working on: {t.title}
                    {t.note ? <span className="text-subtle"> · {t.note}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Floating size & placement popover */}
      {sizeOpen ? (
        <div
          data-no-drag
          style={{ width: Math.min(284, spot.placement.maxWidth) }}
          className={cn(
            "pointer-events-auto mb-2 rounded-2xl bg-raised/95 p-3 shadow-panel ring-1 ring-line-strong/80 backdrop-blur-md",
          )}
        >
          <AvatarSizeControls
            size={avatarSize}
            mode="float"
            hasCall={Boolean(session && view)}
            pinned={pinned}
            hasCustomSpot={spot.hasCustomSpot}
            onSizeChange={(next) => controller.setPrefs({ assistantAvatarSize: clampAvatarSize(next) })}
            onModeChange={(next) => {
              setSizeOpen(false);
              controller.setPrefs({ assistantWindowMode: next });
            }}
            onTogglePinned={(on) => controller.setPrefs({ assistantFloat: on })}
            onResetSpot={spot.resetSpot}
            onClose={() => setSizeOpen(false)}
          />
        </div>
      ) : null}

      {/* Draggable frameless floating avatar */}
      <div
        data-assistant-drag
        data-dragging={spot.dragging ? "true" : undefined}
        onPointerDown={spot.onDragPointerDown}
        onDoubleClick={spot.hasCustomSpot ? spot.resetSpot : undefined}
        onWheel={onAvatarWheel}
        onPointerEnter={voice.warm}
        title="Drag to move · Alt+scroll to resize"
        className={cn(
          "assistant-float-handle pointer-events-auto relative flex flex-col items-center touch-none",
          spot.dragging ? "cursor-grabbing" : "cursor-grab",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "mb-0.5 inline-flex items-center gap-1 rounded-full bg-raised/85 px-2 py-0.5 text-[10px] font-medium text-subtle shadow-sm ring-1 ring-line/70 backdrop-blur-sm transition-opacity",
            spot.dragging ? "opacity-100" : "opacity-0 group-hover/float:opacity-100",
          )}
        >
          <DotsSixIcon size={12} />
          <span>Move</span>
        </span>

        <div
          ref={ring}
          className="assistant-float-aura flex items-center justify-center"
          data-live={live ? "" : undefined}
          data-who={view && view.phase === "speaking" && !view.ducked ? "voice" : view?.heard ? "mic" : "none"}
        >
          {glance ? (
            <Avatar
              spec={glance.character.avatar}
              name={name}
              mood={mood}
              burst={burst}
              size={avatarSize}
              stage={false}
              look
              className="assistant-float-avatar"
            />
          ) : (
            <span
              style={{ width: avatarSize, height: avatarSize }}
              className="block rounded-full bg-sunken shadow-pop ring-1 ring-line"
            />
          )}
        </div>
      </div>

      {/* Optional inline text entry pill while in a live call */}
      {live && typingOpen && session ? (
        <form
          data-no-drag
          className="pointer-events-auto mt-1 mb-1 flex w-[min(276px,calc(100vw-32px))] items-center gap-1.5 rounded-xl bg-raised/95 p-1.5 shadow-pop ring-1 ring-line-strong/80 backdrop-blur-md"
          onSubmit={(event) => {
            event.preventDefault();
            sendTyped();
          }}
        >
          <input
            autoFocus
            value={typedText}
            onChange={(event) => setTypedText(event.target.value)}
            placeholder="Type instead…"
            maxLength={4000}
            aria-label="Type a message to the assistant"
            className="h-7 min-w-0 flex-1 rounded-lg bg-sunken px-2.5 text-xs text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus"
          />
          <IconButton label="Send" size="sm" disabled={typedText.trim() === ""} type="submit">
            <PaperPlaneRightIcon size={14} />
          </IconButton>
        </form>
      ) : null}

      {/* Compact floating control pill beneath the avatar */}
      {session && view ? (
        live ? (
          <FloatingCallPill
            session={session}
            view={view}
            captionsOpen={captionsOpen}
            hasUnreadCaption={!captionsOpen && hasSpeechLines}
            typingOpen={typingOpen}
            sizeOpen={sizeOpen}
            onToggleCaptions={() => setCaptionsOpen((v) => !v)}
            onToggleTyping={() => setTypingOpen((v) => !v)}
            onToggleSize={() => setSizeOpen((v) => !v)}
            onExpandCard={() => controller.setPrefs({ assistantWindowMode: "card" })}
          />
        ) : (
          <div
            data-no-drag
            className="pointer-events-auto mt-1 flex items-center gap-1.5 rounded-full bg-raised/95 px-3 py-1 text-xs shadow-pop ring-1 ring-line-strong/80 backdrop-blur-md"
          >
            <span className="max-w-[160px] truncate text-muted">
              {view.status === "failed" ? "Call did not start" : (view.endedReason ?? "Call ended")}
            </span>
            {view.status === "failed" ? (
              <button
                type="button"
                className="rounded-md px-2 py-0.5 text-xs font-medium text-accent-text hover:bg-hover"
                onClick={() => {
                  wantAssistantTab("voice");
                  controller.navigate({ kind: "assistant" });
                  closeCall();
                }}
              >
                Settings
              </button>
            ) : null}
            <Tip label="Avatar size and view">
              <IconButton label="Avatar size and view" size="sm" active={sizeOpen} onClick={() => setSizeOpen((v) => !v)}>
                <ResizeIcon size={13} />
              </IconButton>
            </Tip>
            <IconButton label="Close" size="sm" onClick={() => closeCall()}>
              <XIcon size={13} />
            </IconButton>
          </div>
        )
      ) : glance ? (
        <FloatingIdlePill
          glance={glance}
          summary={idleSummary}
          sizeOpen={sizeOpen}
          canTalk={controller.hasVoice}
          onTalk={voice.talk}
          onWarm={voice.warm}
          onToggleSize={() => setSizeOpen((v) => !v)}
          onOpenHome={() => controller.navigate({ kind: "assistant" })}
          onUnpin={() => controller.setPrefs({ assistantFloat: false })}
        />
      ) : null}
    </section>
  );
}

function FloatingCallPill(props: {
  session: CallSession;
  view: CallView;
  captionsOpen: boolean;
  hasUnreadCaption: boolean;
  typingOpen: boolean;
  sizeOpen: boolean;
  onToggleCaptions: () => void;
  onToggleTyping: () => void;
  onToggleSize: () => void;
  onExpandCard: () => void;
}) {
  const { session, view } = props;
  const pushToTalk = view.mode === "push-to-talk";
  return (
    <div
      data-no-drag
      className="pointer-events-auto mt-1 flex items-center gap-1 rounded-full bg-raised/95 px-2 py-1 shadow-pop ring-1 ring-line-strong/80 backdrop-blur-md"
    >
      <span
        aria-hidden="true"
        className={cn(
          "ml-1 size-2 shrink-0 rounded-full",
          view.muted || view.micProblem ? "bg-warn" : view.phase === "speaking" ? "bg-accent" : "bg-ok-text",
        )}
      />
      <span className="mr-0.5 max-w-[92px] truncate text-[11px] font-medium text-muted" role="status" aria-live="polite">
        {phaseLabel(view)}
      </span>

      <Tip label={view.muted ? "Unmute microphone" : "Mute microphone"}>
        <IconButton
          label={view.muted ? "Unmute the microphone" : "Mute the microphone"}
          size="sm"
          active={view.muted}
          onClick={() => session.setMuted(!view.muted)}
        >
          {view.muted ? <MicrophoneSlashIcon size={14} /> : <MicrophoneIcon size={14} />}
        </IconButton>
      </Tip>

      <Tip label={pushToTalk ? "Switch to hands-free" : "Switch to push to talk"}>
        <IconButton
          label={pushToTalk ? "Push to talk is on: switch to hands-free" : "Hands-free is on: switch to push to talk"}
          size="sm"
          active={pushToTalk}
          onClick={() => session.setMode(pushToTalk ? "hands-free" : "push-to-talk")}
        >
          <span className="text-[10px] font-semibold">{pushToTalk ? "PTT" : "AUTO"}</span>
        </IconButton>
      </Tip>

      {pushToTalk ? (
        <button
          type="button"
          className={cn(
            "h-6 rounded-full px-2.5 text-[11px] font-medium transition-colors",
            view.talking ? "bg-accent text-accent-fg" : "bg-sunken text-muted hover:bg-hover",
          )}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            session.talk(true);
          }}
          onPointerUp={() => session.talk(false)}
          onPointerCancel={() => session.talk(false)}
        >
          Hold
        </button>
      ) : null}

      <Tip label={props.typingOpen ? "Hide keyboard input" : "Type instead"}>
        <IconButton label={props.typingOpen ? "Hide the keyboard" : "Type instead"} size="sm" active={props.typingOpen} onClick={props.onToggleTyping}>
          <KeyboardIcon size={14} />
        </IconButton>
      </Tip>

      <Tip label={props.captionsOpen ? "Hide speech bubble" : "Show speech bubble"}>
        <div className="relative">
          <IconButton
            label={props.captionsOpen ? "Hide speech bubble" : "Show speech bubble"}
            size="sm"
            active={props.captionsOpen}
            onClick={props.onToggleCaptions}
          >
            <ChatCircleDotsIcon size={14} />
          </IconButton>
          {props.hasUnreadCaption ? <span aria-hidden="true" className="pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full bg-accent" /> : null}
        </div>
      </Tip>

      <Tip label="Avatar size and placement">
        <IconButton label="Avatar size and placement" size="sm" active={props.sizeOpen} onClick={props.onToggleSize}>
          <ResizeIcon size={14} />
        </IconButton>
      </Tip>

      <Tip label="Open transcript card">
        <IconButton label="Open transcript card" size="sm" onClick={props.onExpandCard}>
          <ArrowsOutSimpleIcon size={14} />
        </IconButton>
      </Tip>

      {view.phase === "speaking" ? (
        <Tip label="Stop talking">
          <IconButton label="Stop talking" size="sm" onClick={() => session.interrupt()}>
            <StopCircleIcon size={15} />
          </IconButton>
        </Tip>
      ) : null}

      <Tip label="End the call">
        <IconButton
          label="End the call"
          size="sm"
          className="bg-danger-soft text-danger-text hover:opacity-80"
          onClick={() => session.end()}
        >
          <PhoneDisconnectIcon size={14} />
        </IconButton>
      </Tip>
    </div>
  );
}

function FloatingIdlePill(props: {
  glance: AssistantGlance;
  summary: string;
  sizeOpen: boolean;
  canTalk: boolean;
  onTalk: () => void;
  onWarm: () => void;
  onToggleSize: () => void;
  onOpenHome: () => void;
  onUnpin: () => void;
}) {
  const { glance } = props;
  const needs = glance.needsYou > 0;
  return (
    <div
      data-no-drag
      className={cn(
        "pointer-events-auto mt-1 flex items-center gap-1 rounded-full bg-raised/92 px-2.5 py-1 shadow-pop ring-1 ring-line-strong/75 backdrop-blur-md transition-opacity",
        props.sizeOpen || needs ? "opacity-100" : "opacity-85 group-hover/float:opacity-100",
      )}
    >
      <button
        type="button"
        onClick={props.onOpenHome}
        title={`${glance.name}: ${props.summary}`}
        className="flex max-w-[132px] items-center gap-1.5 truncate rounded-full px-1 py-0.5 text-left text-xs hover:text-fg"
      >
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", needs ? "bg-warn-text" : glance.running > 0 ? "bg-accent" : "bg-ok-text")}
        />
        <span className="truncate font-medium text-fg">{glance.name}</span>
        {needs ? <span className="shrink-0 text-2xs font-semibold text-warn-text">({glance.needsYou})</span> : null}
      </button>

      {props.canTalk ? (
        <Tip label={`Talk to ${glance.name}`}>
          <IconButton label={`Talk to ${glance.name}`} size="sm" onClick={props.onTalk} onFocus={props.onWarm}>
            <MicrophoneIcon size={14} />
          </IconButton>
        </Tip>
      ) : null}

      <Tip label="Avatar size and placement">
        <IconButton label="Avatar size and placement" size="sm" active={props.sizeOpen} onClick={props.onToggleSize}>
          <ResizeIcon size={14} />
        </IconButton>
      </Tip>

      <Tip label="Stop floating on screen">
        <IconButton label="Stop floating on screen" size="sm" onClick={props.onUnpin}>
          <PushPinSlashIcon size={13} />
        </IconButton>
      </Tip>
    </div>
  );
}

function FloatingCaptions(props: { view: CallView; name: string }) {
  const { view } = props;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.lines, view.partial]);
  const recent = view.lines.slice(-2);
  return (
    <div ref={box} className="max-h-[188px] space-y-1.5 overflow-y-auto pr-0.5 text-xs [scrollbar-width:thin]">
      {recent.map((line, i) => (
        <Line key={`${line.turn}-${line.role}-${i}`} line={line} name={props.name} />
      ))}
      {view.partial !== "" ? (
        <p className="rounded-lg border border-dashed border-line bg-sunken/50 px-2.5 py-1.5 text-xs leading-snug text-fg/85 italic">
          {view.partial}
        </p>
      ) : null}
    </div>
  );
}

function MovableCard(props: { session: CallSession; view: CallView }) {
  const { session, view } = props;
  const controller = useController();
  const glance = useApp((s) => s.assistantGlance);
  const avatarSize = clampAvatarSize(useApp((s) => s.prefs.assistantAvatarSize));
  const pinned = useApp((s) => s.prefs.assistantFloat);
  const live = callIsLive(session);

  const [expanded, setExpanded] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);

  usePushToTalkSpace(session, view, live);

  const spot = useMovableSpot(expanded ? 440 : 364, expanded ? 560 : 380);
  const ring = useRing(session, live);
  const last = view.metrics[view.metrics.length - 1];
  const activeTasks = view.tasks.filter((t) => t.status === "running" || t.status === "queued" || t.status === "waiting");
  const name = glance?.name ?? "Assistant";
  const status = view.error ?? view.notice?.text ?? null;
  const headerAvatarPx = cardAvatarSize(avatarSize);

  return (
    <section
      ref={spot.boxRef}
      aria-label={`Call with ${name}`}
      onClickCapture={spot.onClickCapture}
      style={{ left: spot.coords.left, top: spot.coords.top }}
      className={cn(
        "fixed z-[var(--z-toast)] flex flex-col overflow-hidden rounded-2xl bg-raised/96 shadow-panel ring-1 ring-line backdrop-blur-md",
        expanded ? "h-[min(640px,calc(100vh-32px))] w-[min(440px,calc(100vw-32px))]" : "w-[min(368px,calc(100vw-32px))]",
      )}
    >
      <header
        data-assistant-drag
        onPointerDown={spot.onDragPointerDown}
        onDoubleClick={spot.hasCustomSpot ? spot.resetSpot : undefined}
        title="Drag to move · Double-click to reset spot"
        className={cn(
          "flex items-center gap-3 border-b border-line/60 px-3.5 py-3 select-none touch-none",
          spot.dragging ? "cursor-grabbing" : "cursor-grab",
        )}
      >
        <div
          ref={ring}
          className="assistant-float-aura relative shrink-0"
          data-live={live ? "" : undefined}
          data-who={view.phase === "speaking" && !view.ducked ? "voice" : view.heard ? "mic" : "none"}
        >
          {glance ? (
            <Avatar
              spec={glance.character.avatar}
              name={name}
              mood={moodOfCall(view)}
              size={headerAvatarPx}
              stage={false}
              look
              className="assistant-float-avatar"
            />
          ) : (
            <span style={{ width: headerAvatarPx, height: headerAvatarPx }} className="block rounded-full bg-sunken" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold tracking-[-0.01em] text-fg">{name}</span>
            <DotsSixIcon size={13} className="shrink-0 text-subtle/70" aria-hidden="true" />
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted" role="status" aria-live="polite">
            {live ? (
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  view.muted || view.micProblem ? "bg-warn" : view.phase === "speaking" ? "bg-accent" : "bg-ok-text",
                )}
              />
            ) : null}
            <span className="truncate">{phaseLabel(view)}</span>
            {live && view.status === "ready" && last?.firstAudioMs != null ? (
              <span className="shrink-0 text-subtle">· {(last.firstAudioMs / 1000).toFixed(1)} s</span>
            ) : null}
          </div>
          {activeTasks.length === 1 ? (
            <div className="mt-0.5 truncate text-2xs text-subtle">Working on: {activeTasks[0]!.title}</div>
          ) : activeTasks.length > 1 ? (
            <div className="mt-0.5 truncate text-2xs text-subtle">
              Working on {activeTasks.length} tasks: {activeTasks.map((t) => t.title).join(", ")}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Tip label="Float avatar in view">
            <IconButton
              label="Float avatar in view"
              size="sm"
              onClick={() => controller.setPrefs({ assistantWindowMode: "float" })}
            >
              <PictureInPictureIcon size={14} />
            </IconButton>
          </Tip>
          <Tip label="Avatar size and placement">
            <IconButton label="Avatar size and placement" size="sm" active={sizeOpen} onClick={() => setSizeOpen((v) => !v)}>
              <ResizeIcon size={14} />
            </IconButton>
          </Tip>
          <Tip label={expanded ? "Compact card" : "Taller transcript"}>
            <IconButton label={expanded ? "Smaller" : "Larger"} size="sm" active={expanded} onClick={() => setExpanded((v) => !v)}>
              <WaveformIcon size={14} />
            </IconButton>
          </Tip>
          {!live ? (
            <IconButton label="Close" size="sm" onClick={() => closeCall()}>
              <XIcon size={14} />
            </IconButton>
          ) : null}
        </div>
      </header>

      {sizeOpen ? (
        <div className="border-b border-line/60 bg-sunken/45 px-3.5 py-2.5" data-no-drag>
          <AvatarSizeControls
            size={avatarSize}
            mode="card"
            hasCall
            pinned={pinned}
            hasCustomSpot={spot.hasCustomSpot}
            onSizeChange={(next) => controller.setPrefs({ assistantAvatarSize: clampAvatarSize(next) })}
            onModeChange={(next) => {
              setSizeOpen(false);
              controller.setPrefs({ assistantWindowMode: next });
            }}
            onTogglePinned={(on) => controller.setPrefs({ assistantFloat: on })}
            onResetSpot={spot.resetSpot}
            onClose={() => setSizeOpen(false)}
          />
        </div>
      ) : null}

      {status ? (
        <p
          className={cn(
            "mx-4 mt-2.5 rounded-lg px-2.5 py-1.5 text-xs",
            view.error || view.notice?.level === "warn" ? "bg-warn-soft text-warn-text" : "bg-sunken text-muted",
          )}
        >
          {status}
        </p>
      ) : null}
      {view.micProblem ? <p className="mx-4 mt-2 rounded-lg bg-warn-soft px-2.5 py-1.5 text-xs text-warn-text">{view.micProblem}</p> : null}
      {view.status === "failed" && view.error?.includes("not installed") ? (
        <p className="mx-4 mt-1.5 text-xs text-muted">Open Assistant, then Voice, to install it.</p>
      ) : null}

      {live && view.approval ? (
        <div className="mx-4 mt-2.5">
          <ApprovalBox approval={view.approval} onDecide={(allow) => session.decide(view.approval!.id, allow)} />
        </div>
      ) : null}

      <Transcript view={view} tall={expanded} name={name} />

      {view.tasks.length > 0 ? (
        <ul className="mx-4 mb-2.5 flex flex-wrap gap-1.5">
          {view.tasks.slice(0, 6).map((t) => (
            <li
              key={t.id}
              title={t.note ? `${t.title} — ${t.note}` : t.title}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line/70 bg-sunken/70 px-2 py-0.5 text-2xs text-muted"
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  t.status === "completed" || t.status === "unverified"
                    ? "bg-ok-text"
                    : t.status === "failed" || t.status === "cancelled"
                      ? "bg-danger-text"
                      : t.status === "blocked" || t.status === "paused"
                        ? "bg-warn-text"
                        : "bg-accent",
                )}
              />
              <span className="truncate">{t.title}</span>
              {t.note && (t.status === "running" || t.status === "blocked" || t.status === "paused") ? (
                <span className="max-w-[140px] truncate text-subtle">· {t.note}</span>
              ) : null}
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

function ApprovalBox(props: { approval: CallApproval; onDecide: (allow: boolean) => void }) {
  const { approval, onDecide } = props;
  return (
    <div
      role="region"
      aria-label="Authorization request"
      className="rounded-xl border border-accent/35 bg-accent-soft/20 px-3 py-2.5"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-semibold text-fg">{approval.title}</span>
        <span className="shrink-0 text-[10px] text-subtle">Click or say “go ahead”</span>
      </div>
      <p className="mt-1 truncate rounded-md bg-sunken/80 px-2 py-1 font-mono text-[11px] text-fg/90" title={approval.detail}>
        {approval.detail}
      </p>
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button
          type="button"
          className="h-7 rounded-lg bg-sunken px-2.5 text-xs font-medium text-muted transition-colors hover:bg-hover hover:text-fg"
          onClick={() => onDecide(false)}
        >
          {approval.denyLabel}
        </button>
        <button
          type="button"
          className="h-7 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-fg transition-opacity hover:opacity-90"
          onClick={() => onDecide(true)}
        >
          {approval.allowLabel}
        </button>
      </div>
    </div>
  );
}

function AvatarSizeControls(props: {
  size: number;
  mode: AssistantWindowMode;
  hasCall: boolean;
  pinned: boolean;
  hasCustomSpot: boolean;
  onSizeChange: (next: number) => void;
  onModeChange: (next: AssistantWindowMode) => void;
  onTogglePinned: (on: boolean) => void;
  onResetSpot: () => void;
  onClose: () => void;
}) {
  const pct = ((props.size - ASSISTANT_AVATAR_MIN) / (ASSISTANT_AVATAR_MAX - ASSISTANT_AVATAR_MIN)) * 100;
  return (
    <div className="space-y-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-fg">Avatar size</span>
        <div className="flex items-center gap-1">
          <span className="tabular-nums text-2xs text-subtle">{props.size} px</span>
          <IconButton label="Close size controls" size="sm" onClick={props.onClose}>
            <XIcon size={12} />
          </IconButton>
        </div>
      </div>

      <div className="flex items-center gap-1">
        {AVATAR_SIZE_PRESETS.map((preset) => {
          const active = Math.abs(props.size - preset.size) <= 6;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => props.onSizeChange(preset.size)}
              className={cn(
                "h-6 flex-1 rounded-lg text-[11px] font-semibold transition-colors",
                active ? "bg-accent text-accent-fg" : "bg-sunken text-muted hover:bg-hover hover:text-fg",
              )}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <IconButton
          label="Smaller avatar"
          size="sm"
          disabled={props.size <= ASSISTANT_AVATAR_MIN}
          onClick={() => props.onSizeChange(stepAvatarSize(props.size, -1))}
        >
          <MinusIcon size={12} />
        </IconButton>
        <input
          type="range"
          min={ASSISTANT_AVATAR_MIN}
          max={ASSISTANT_AVATAR_MAX}
          step={4}
          value={props.size}
          aria-label="Avatar size in pixels"
          style={{ "--v": `${pct.toFixed(1)}%` } as CSSProperties}
          onChange={(e) => props.onSizeChange(Number(e.target.value))}
          className="companion-range flex-1"
        />
        <IconButton
          label="Larger avatar"
          size="sm"
          disabled={props.size >= ASSISTANT_AVATAR_MAX}
          onClick={() => props.onSizeChange(stepAvatarSize(props.size, 1))}
        >
          <PlusIcon size={12} />
        </IconButton>
      </div>

      {props.hasCall ? (
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-0.5">
          <button
            type="button"
            onClick={() => props.onModeChange("float")}
            className={cn(
              "h-6 rounded-md text-[11px] font-medium transition-colors",
              props.mode === "float" ? "bg-raised text-fg shadow-sm" : "text-muted hover:text-fg",
            )}
          >
            Floating avatar
          </button>
          <button
            type="button"
            onClick={() => props.onModeChange("card")}
            className={cn(
              "h-6 rounded-md text-[11px] font-medium transition-colors",
              props.mode === "card" ? "bg-raised text-fg shadow-sm" : "text-muted hover:text-fg",
            )}
          >
            Transcript card
          </button>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 pt-0.5">
        <button
          type="button"
          onClick={() => props.onTogglePinned(!props.pinned)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors",
            props.pinned ? "bg-accent-soft/40 text-accent-text" : "bg-sunken text-muted hover:bg-hover hover:text-fg",
          )}
        >
          {props.pinned ? <PushPinIcon size={12} /> : <PushPinSlashIcon size={12} />}
          <span>{props.pinned ? "Pinned on screen" : "Pin on screen"}</span>
        </button>

        <button
          type="button"
          disabled={!props.hasCustomSpot}
          onClick={props.onResetSpot}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
        >
          <ArrowCounterClockwiseIcon size={12} />
          <span>Reset spot</span>
        </button>
      </div>
    </div>
  );
}

/** The lines of the conversation, newest at the bottom, and the words being said now. */
function Transcript(props: { view: CallView; tall: boolean; name: string }) {
  const { view } = props;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.lines, view.partial]);
  const lines = props.tall ? view.lines : view.lines.slice(-4);
  return (
    <div ref={box} className={cn("mx-4 my-2.5 min-h-[56px] flex-1 space-y-2 overflow-y-auto text-sm [scrollbar-width:thin]", props.tall ? "" : "max-h-[216px]")}>
      {lines.length === 0 && view.partial === "" ? <p className="py-1 text-xs text-subtle">{emptyLine(view)}</p> : null}
      {lines.map((line, i) => (
        <Line key={`${line.turn}-${line.role}-${i}`} line={line} name={props.name} />
      ))}
      {view.partial !== "" ? (
        <p className="rounded-lg border border-dashed border-line bg-sunken/45 px-2.5 py-1.5 text-xs leading-snug text-fg/80 italic">
          {view.partial}
        </p>
      ) : null}
    </div>
  );
}

function Line(props: { line: CallLine; name: string }) {
  const { line } = props;
  const mine = line.role === "user";
  return (
    <div className={cn("rounded-lg px-2.5 py-1.5 text-xs leading-relaxed", mine ? "bg-sunken/70 text-muted" : "bg-accent-soft/35 text-fg")}>
      <span className="mr-1.5 text-[10px] font-semibold tracking-wider text-subtle uppercase">{mine ? "You" : props.name}</span>
      {line.interrupted && line.heard !== null ? (
        <>
          {line.heard.trim() === "" ? <span className="text-subtle">(cut off)</span> : line.heard}
          <span className="text-subtle"> …</span>
        </>
      ) : (
        line.text
      )}
      {!line.done ? <span className="text-subtle"> …</span> : null}
    </div>
  );
}

function Controls(props: { session: CallSession; view: CallView }) {
  const { session, view } = props;
  const [text, setText] = useState("");
  const [typing, setTyping] = useState(view.micProblem !== null);
  const problem = view.micProblem !== null;
  useEffect(() => {
    if (problem) setTyping(true);
  }, [problem]);
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
        <IconButton
          label={view.muted ? "Unmute the microphone" : "Mute the microphone"}
          size="md"
          active={view.muted}
          onClick={() => session.setMuted(!view.muted)}
        >
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
            className={cn(
              "h-8 rounded-lg px-3 text-xs font-medium transition-colors",
              view.talking ? "bg-accent text-accent-fg" : "bg-sunken text-muted hover:bg-hover",
            )}
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

/** Moves the face's aura with the sound on the line: the microphone's level and the voice's, polled once a frame. */
function useRing(session: CallSession | null, live: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!session || !el || !live || typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined;
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
