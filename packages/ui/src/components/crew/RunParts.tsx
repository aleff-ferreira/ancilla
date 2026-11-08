import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { actionText, callTime, type ActionLook, type Glyph, type Seg, type SegTone, type Tick } from "../../model/runCard.js";
import type { TaskPlanView, TaskStepStatus } from "../../model/taskPlan.js";
import {
  CheckCircleIcon,
  CircleIcon,
  ClockCounterClockwiseIcon,
  ClockIcon,
  ListChecksIcon,
  MinusCircleIcon,
  ShieldWarningIcon,
  StopCircleIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "../ui/icons.js";
import { Spinner, cn } from "../ui/primitives.js";
import { SwapIcon } from "../ui/sourced.js";

/** The pieces the run card and the plan card are made of: the glyph, the swapping line, the spine, the heartbeat, the steps. */

const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];

/**
 * A value that holds for at least `ms` before it gives way to the next, then catches up to the newest. A prompt that
 * makes a call every half second would otherwise rewrite its first line faster than it can be read.
 */
export function useDwell<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const changedAt = useRef(0);
  useEffect(() => {
    if (Object.is(shown, value)) return undefined;
    const wait = Math.max(0, changedAt.current + ms - Date.now());
    const timer = window.setTimeout(() => {
      changedAt.current = Date.now();
      setShown(value);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [value, shown, ms]);
  return shown;
}

/**
 * Keys that turned on while this was mounted: a step that landed since the last render, as against one that was
 * already done when the card appeared. Only the first earns the glint or the pop; opening a card plays nothing.
 */
export function useFresh(entries: readonly { key: string; on: boolean }[]): ReadonlySet<string> {
  const before = useRef<Map<string, boolean> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const previous = before.current;
    before.current = new Map(entries.map((entry) => [entry.key, entry.on]));
    if (!previous) return;
    const added = entries.filter((entry) => entry.on && previous.get(entry.key) === false).map((entry) => entry.key);
    if (added.length > 0) setFresh((current) => new Set([...current, ...added]));
  });
  return fresh;
}

/** One line of text that gives way to the next with a short slide, so the card reads as moving on rather than flickering. */
export function Swap(props: { id: string; className?: string; title?: string; lite?: boolean; children: ReactNode }) {
  const reduce = useReducedMotion();
  const shift = props.lite || reduce ? 0 : 7;
  return (
    <span className={cn("relative block overflow-hidden", props.className)}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={props.id}
          className="block overflow-hidden text-ellipsis"
          title={props.title}
          initial={{ opacity: 0, y: shift }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -shift }}
          transition={{ duration: props.lite ? 0.16 : 0.22, ease: EASE_OUT }}
        >
          {props.children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** The state glyph at the card's left: the ring while it runs, the outcome once it ended; a change blurs from one to the next. */
export function RunGlyph({ glyph }: { glyph: Glyph | "plan" }) {
  let tone: string;
  let icon: ReactNode;
  switch (glyph) {
    case "plan": tone = "mute"; icon = <ListChecksIcon size={16} />; break;
    case "working": tone = "work"; icon = <Spinner size={14} />; break;
    case "waiting": tone = "need"; icon = <ShieldWarningIcon size={16} className="attention-pulse" />; break;
    case "stale": tone = "mute"; icon = <ClockCounterClockwiseIcon size={16} />; break;
    case "done": tone = "ok"; icon = <CheckCircleIcon size={17} weight="fill" />; break;
    case "failed": tone = "fail"; icon = <WarningCircleIcon size={17} weight="fill" />; break;
    case "stopped": tone = "mute"; icon = <StopCircleIcon size={17} />; break;
    default: tone = "mute"; icon = <MinusCircleIcon size={17} />;
  }
  return (
    <span className={cn("run-glyph", tone)} aria-hidden="true">
      <SwapIcon value={glyph}>{icon}</SwapIcon>
    </span>
  );
}

/** The call going now, or the last to end, in the transcript's words: a verb and what it acted on. */
export function ActionLine({ action }: { action: ActionLook }) {
  return (
    <span className={cn("act", action.live && "live")} title={action.note ?? actionText(action)}>
      <span className="v">{action.verb}</span>
      {action.subject ? <span className={cn("s", !action.mono && "!font-sans !text-xs")}>{action.subject}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------- the spine

/** Past this many segments neighbours of one tone merge into one, so a plan of a hundred steps stays a line. */
const SEG_LIMIT = 40;

interface Packed {
  key: string;
  tone: SegTone;
  n: number;
  label: string;
}

function pack(segs: readonly Seg[]): Packed[] {
  if (segs.length <= SEG_LIMIT) return segs.map((seg) => ({ key: seg.key, tone: seg.tone, n: 1, label: seg.label }));
  const out: Packed[] = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (last && last.tone === seg.tone) {
      last.n += 1;
      last.label = "";
    } else {
      out.push({ key: seg.key, tone: seg.tone, n: 1, label: seg.label });
    }
  }
  return out;
}

export interface SpineProps {
  segs: readonly Seg[];
  /** The progress bar's name for a reader: `Plan steps completed`. */
  label: string;
  className?: string;
}

/** The plan's steps as equal segments: done ones settle in green left to right, the active one flows, the rest wait. */
export function Spine({ segs, label, className }: SpineProps) {
  const packed = pack(segs);
  const fresh = useFresh(packed.map((seg) => ({ key: seg.key, on: seg.tone === "done" })));
  const done = segs.filter((seg) => seg.tone === "done").length;
  return (
    <div className={cn("run-spine", className)} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={segs.length} aria-valuenow={done} aria-valuetext={`${done} of ${segs.length}`}>
      {packed.map((seg) => (
        <i key={seg.key} className={cn(seg.tone, fresh.has(seg.key) && "fresh")} style={seg.n > 1 ? { flexGrow: seg.n } : undefined} title={seg.label || undefined}>
          <b className="dn" />
          <b className="lv" />
        </i>
      ))}
    </div>
  );
}

/** With no plan the spine is a hairline that answers each call that ends with one pulse; `beat` counts the calls that have. */
export function Hairline({ beat, finished }: { beat: number; finished?: boolean }) {
  return (
    <div className={cn("run-spine rhythm", finished && "done")} aria-hidden="true">
      <i className="live">
        <b className="lv" />
        {beat > 0 && !finished ? <b key={beat} className="pulse" /> : null}
      </i>
    </div>
  );
}

/** One tick per call, the newest at the right: tall and blue while it runs, shorter and green once it landed. */
export function Trail({ ticks }: { ticks: readonly Tick[] }) {
  if (ticks.length === 0) return null;
  return (
    <span className="run-trail" aria-hidden="true">
      {ticks.map((tick) => (
        <i key={tick.id} className={tick.tone} />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- the steps

/** A step's mark: a ring that turns, a check that pops when the step lands, an empty circle for what is still to do. */
export function StepMark(props: { status: TaskStepStatus; plan: Pick<TaskPlanView, "animate" | "state">; fresh?: boolean }) {
  switch (props.status) {
    case "completed":
      return <CheckCircleIcon size={17} weight="fill" className={cn("text-ok", props.fresh && "run-pop")} aria-label="Done" />;
    case "inProgress":
      return props.plan.animate
        ? <Spinner size={13} className="text-accent-text" label="In progress" />
        : <ClockIcon size={16} className="text-subtle" aria-label={props.plan.state === "waiting" ? "Waiting for you" : "Last reported active; completion unconfirmed"} />;
    case "cancelled":
      return <XCircleIcon size={16} className="text-subtle" aria-label="Cancelled" />;
    case "failed":
      return <XCircleIcon size={16} className="text-danger" aria-label="Failed" />;
    case "unknown":
      return <CircleIcon size={16} className="text-subtle" aria-label="Status not reported" />;
    default:
      return <CircleIcon size={16} className="text-[var(--border-strong)]" aria-label="To do" />;
  }
}

/** The plan's checklist, as the run card and the plan card both show it. */
export function PlanSteps({ view }: { view: TaskPlanView }) {
  const fresh = useFresh(view.items.map((item, index) => ({ key: `${index}:${item.text}`, on: item.status === "completed" })));
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const container = list.current?.closest<HTMLElement>(".crew-body") ?? null;
    const row = list.current?.children[view.activeIndex] as HTMLElement | undefined;
    if (!container || !row) return;
    // Scroll only this card's body, clear of its sticky footer: a plan update must not move the transcript or focus.
    const box = container.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    const floor = box.bottom - (container.querySelector<HTMLElement>(".run-foot")?.offsetHeight ?? 0);
    if (at.top < box.top) container.scrollTop -= box.top - at.top + 8;
    else if (at.bottom > floor) container.scrollTop += at.bottom - floor + 8;
  }, [view.activeIndex]);
  return (
    <ol ref={list} className="run-steps">
      {view.items.map((item, index) => {
        const running = item.status === "inProgress" && view.animate;
        const cls = item.status === "completed" ? "done" : running ? "live" : item.status === "failed" ? "fail" : "";
        return (
          <li key={`${index}:${item.text}`} className={cls} aria-current={running ? "step" : undefined}>
            <span className="mk">
              <StepMark status={item.status} plan={view} fresh={fresh.has(`${index}:${item.text}`)} />
            </span>
            <span className="tx">
              {running ? item.activeForm ?? item.text : item.text}
              {item.status === "inProgress" && !view.animate ? <span className="tag">{view.state === "waiting" ? "waiting" : "last active"}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- the latest calls

function CallMark({ tone }: { tone: ActionLook["tone"] }) {
  if (tone === "work") return <Spinner size={11} className="text-accent-text" />;
  if (tone === "need") return <ShieldWarningIcon size={13} className="text-warn" />;
  return <span className={cn("run-dot", tone === "fail" && "fail", tone === "idle" && "idle")} />;
}

/** The last few calls, newest at the bottom: each lands in place and the oldest slips away, so the list is a quiet log of work. */
export function Latest({ items }: { items: readonly ActionLook[] }) {
  const reduce = useReducedMotion();
  return (
    <ul className="run-latest" aria-label="Latest actions">
      <AnimatePresence initial={false} mode="popLayout">
        {items.map((action) => (
          <motion.li
            key={action.id}
            layout="position"
            className={action.tone}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
          >
            <span className="mk"><CallMark tone={action.tone} /></span>
            <span className="v">{action.verb}</span>
            {action.subject ? <span className={cn("s", !action.mono && "!font-sans !text-xs")} title={action.note ?? action.subject}>{action.subject}</span> : <span className="s" />}
            <span className="ms">{callTime(action.ms)}</span>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}
