import type { JSX, ReactNode } from "react";
import { CheckIcon, InfoIcon, WarningCircleIcon, XIcon } from "./icons.js";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { useApp, useController } from "../../app/context.js";
import type { Toast } from "../../model/store.js";
import { cn } from "./primitives.js";

const TOAST_SPRING_PHYSICS: Transition = { type: "spring", stiffness: 420, damping: 34, mass: 0.75 };
const DISMISSAL_BEZIER = [0.23, 1, 0.32, 1] as const;
const LATERAL_DRAG_BOUNDS = { left: 0, right: 0 };
const ELASTIC_PULL = 0.18;
const FADED_OUT = Object.freeze({ opacity: 0 });

const TOAST_CONTAINER_CLASS = "pointer-events-none fixed right-4 bottom-4 z-[var(--z-toast)] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2";
const TOAST_WRAPPER_CLASS = "pointer-events-auto relative";
const DISMISS_BUTTON_CLASS = "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-subtle transition-colors hover:bg-hover hover:text-fg";
const ACTION_BUTTON_CLASS = "mt-2 inline-flex h-7 items-center rounded-full bg-active px-3 text-xs font-medium text-fg transition-colors hover:bg-hover";

function resolveToneTheme(tone: Toast["tone"]): { glyph: ReactNode; badgeClasses: string } {
  switch (tone) {
    case "error":
      return { glyph: <WarningCircleIcon size={14} />, badgeClasses: "bg-danger-soft text-danger-text" };
    case "success":
      return { glyph: <CheckIcon size={14} />, badgeClasses: "bg-[color-mix(in_oklch,var(--ok)_16%,transparent)] text-ok-text" };
    default:
      return { glyph: <InfoIcon size={14} />, badgeClasses: "bg-active text-muted" };
  }
}

interface ToastNotificationCardProps {
  toast: Toast;
  reducedMotion: boolean | null;
  onDismiss: (id: number) => void;
}

function ToastNotificationCard({ toast, reducedMotion, onDismiss }: ToastNotificationCardProps): JSX.Element {
  const { glyph, badgeClasses } = resolveToneTheme(toast.tone);
  const isAlertRole = toast.tone === "error";

  const spawnPose = reducedMotion ? FADED_OUT : { opacity: 0, y: 22, scale: 0.96, filter: "blur(10px)" };
  const visiblePose = reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" };
  const departPose = reducedMotion
    ? FADED_OUT
    : { opacity: 0, x: 32, scale: 0.96, filter: "blur(8px)", transition: { duration: 0.18, ease: DISMISSAL_BEZIER } };

  const onDragRelease = (_: unknown, gesture: { offset: { x: number }; velocity: { x: number } }) => {
    if (Math.abs(gesture.offset.x) > 72 || Math.abs(gesture.velocity.x) > 520) {
      onDismiss(toast.id);
    }
  };

  const onExecuteAction = () => {
    const actionRunner = toast.action;
    if (actionRunner) {
      actionRunner.run();
      onDismiss(toast.id);
    }
  };

  return (
    <motion.li
      layout
      initial={spawnPose}
      animate={visiblePose}
      exit={departPose}
      transition={TOAST_SPRING_PHYSICS}
      drag={reducedMotion ? false : "x"}
      dragConstraints={LATERAL_DRAG_BOUNDS}
      dragElastic={ELASTIC_PULL}
      onDragEnd={onDragRelease}
      className={TOAST_WRAPPER_CLASS}
    >
      <div role={isAlertRole ? "alert" : "status"} className="flex items-start gap-3 rounded-2xl bg-raised p-3 shadow-pop">
        <span className={cn("mt-px inline-flex size-7 shrink-0 items-center justify-center rounded-full", badgeClasses)}>
          {glyph}
        </span>
        <div className="flex-1 min-w-0 pt-0.5">
          <span className="block text-sm leading-5 font-medium text-fg">{toast.title}</span>
          {toast.detail && <p className="mt-0.5 line-clamp-3 text-xs leading-4 break-words text-muted">{toast.detail}</p>}
          {toast.action && (
            <button type="button" onClick={onExecuteAction} className={ACTION_BUTTON_CLASS}>
              <span>{toast.action.label}</span>
            </button>
          )}
        </div>
        <button type="button" aria-label="Dismiss" onClick={() => onDismiss(toast.id)} className={DISMISS_BUTTON_CLASS}><XIcon size={14} /></button>
      </div>
    </motion.li>
  );
}

export function Toasts(): JSX.Element {
  const { dismissToast } = useController();
  const currentToasts = useApp((state) => state.toasts);
  const isReduced = useReducedMotion();

  return (
    <ol aria-live="polite" aria-atomic="false" className={TOAST_CONTAINER_CLASS}>
      <AnimatePresence initial={false} mode="popLayout">
        {currentToasts.map((item) => (
          <ToastNotificationCard key={item.id} toast={item} reducedMotion={isReduced} onDismiss={dismissToast} />
        ))}
      </AnimatePresence>
    </ol>
  );
}
