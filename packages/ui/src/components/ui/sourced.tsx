import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "./primitives.js";

const COLLAPSE_EASE: [number, number, number, number] = [0.23, 1, 0.32, 1];
const PIXEL_CELL_SIZE = 3;

const PIXEL_STAGGER_MS: readonly number[] = Array.from({ length: PIXEL_CELL_SIZE * PIXEL_CELL_SIZE }, (_, idx) => {
  const row = Math.floor(idx / PIXEL_CELL_SIZE);
  const col = idx % PIXEL_CELL_SIZE;
  return (col + Math.abs(row - 1)) * 90;
});

/**
 * Animates vertical disclosure height using CSS grid row sizing (`0fr` -> `1fr`).
 * Children mount lazily upon the first open state and stay mounted to allow smooth closing.
 */
export function Collapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [hasOpened, setHasOpened] = useState(open);

  useEffect(() => {
    if (open && !hasOpened) {
      setHasOpened(true);
    }
  }, [open, hasOpened]);

  const containerStyle: CSSProperties = {
    gridTemplateRows: open ? "1fr" : "0fr",
    opacity: open ? 1 : 0,
  };

  const closedAttributes = open ? undefined : ({ inert: "" } as Record<string, string>);

  return (
    <div
      className={cn("grid transition-[grid-template-rows,opacity] duration-[260ms] ease-out", className)}
      style={containerStyle}
      aria-hidden={open ? undefined : true}
      {...closedAttributes}
    >
      <div className="min-h-0 overflow-hidden">{hasOpened ? children : null}</div>
    </div>
  );
}

/**
 * Compact 3x3 pixel matrix activity indicator with a staggered chevron pulse.
 */
export function PixelLoader({
  className,
  small = false,
}: {
  className?: string;
  small?: boolean;
}) {
  const gridTrackClass = small ? "grid-cols-[repeat(3,3px)] !gap-px" : "grid-cols-[repeat(3,4px)]";
  const dotSizeClass = small ? "size-[3px]" : "size-[4px]";

  return (
    <span aria-hidden="true" className={cn("pixel-loader grid shrink-0 gap-[1.5px]", gridTrackClass, className)}>
      {PIXEL_STAGGER_MS.map((delayMs, cellIndex) => (
        <span
          key={cellIndex}
          className={cn("rounded-[1px] bg-current", dotSizeClass)}
          style={{ animationDelay: `${delayMs}ms` }}
        />
      ))}
    </span>
  );
}

const DIGIT_ROLL_DURATION_MS = 360;
const DIGIT_COOLDOWN_MS = 700;
const DIGIT_CELL_HEIGHT = "1.3em";

/**
 * Animated counter display that rolls changed digits vertically, snapping when
 * rapid consecutive updates arrive faster than the cooldown threshold.
 */
export function RollingDigits({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const committedValueRef = useRef(value);
  const lastAnimationMsRef = useRef(Number.NEGATIVE_INFINITY);

  const [prevText, setPrevText] = useState(value);
  const [nextText, setNextText] = useState(value);
  const [isRolling, setIsRolling] = useState(false);
  const [hasShifted, setHasShifted] = useState(false);
  const [rollDirection, setRollDirection] = useState<"up" | "down">("up");

  useEffect(() => {
    if (committedValueRef.current === value) {
      return;
    }

    const prior = committedValueRef.current;
    committedValueRef.current = value;

    const timestamp = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (timestamp - lastAnimationMsRef.current < DIGIT_COOLDOWN_MS) {
      lastAnimationMsRef.current = timestamp;
      setIsRolling(false);
      setHasShifted(false);
      setPrevText(value);
      setNextText(value);
      return;
    }

    lastAnimationMsRef.current = timestamp;
    const priorNumeric = Number.parseInt(prior, 10);
    const nextNumeric = Number.parseInt(value, 10);
    const isDecreasing = Number.isFinite(priorNumeric) && Number.isFinite(nextNumeric) && nextNumeric < priorNumeric;

    setRollDirection(isDecreasing ? "down" : "up");
    setPrevText(prior);
    setNextText(value);
    setHasShifted(false);
    setIsRolling(true);

    let rafInner = 0;
    const rafOuter = requestAnimationFrame(() => {
      rafInner = requestAnimationFrame(() => setHasShifted(true));
    });

    const settleTimer = window.setTimeout(() => {
      setIsRolling(false);
      setHasShifted(false);
      setPrevText(value);
    }, DIGIT_ROLL_DURATION_MS);

    return () => {
      cancelAnimationFrame(rafOuter);
      cancelAnimationFrame(rafInner);
      window.clearTimeout(settleTimer);
    };
  }, [value]);

  const displayedText = isRolling ? nextText : prevText;

  return (
    <span className={cn("inline-flex tabular-nums", className)} aria-label={value}>
      {Array.from({ length: displayedText.length }, (_, idx) => {
        const oldChar = prevText[idx] ?? "";
        const newChar = displayedText[idx] ?? "";

        if (!isRolling || oldChar === newChar) {
          return (
            <span key={`${idx}-${newChar}`} aria-hidden="true" className="whitespace-pre">
              {newChar}
            </span>
          );
        }

        const isDown = rollDirection === "down";
        const firstGlyph = isDown ? newChar : oldChar;
        const secondGlyph = isDown ? oldChar : newChar;
        const initialOffset = isDown ? `-${DIGIT_CELL_HEIGHT}` : "0";
        const targetOffset = isDown ? "0" : `-${DIGIT_CELL_HEIGHT}`;

        return (
          <span
            key={`${idx}-${oldChar}-${newChar}-${rollDirection}`}
            aria-hidden="true"
            className="relative inline-block overflow-hidden whitespace-pre"
            style={{ height: DIGIT_CELL_HEIGHT, lineHeight: DIGIT_CELL_HEIGHT, alignSelf: "center" }}
          >
            <span
              className="flex flex-col"
              style={{
                transition: "transform 320ms cubic-bezier(0.4, 0, 0.2, 1)",
                transform: `translateY(${hasShifted ? targetOffset : initialOffset})`,
              }}
            >
              <span style={{ height: DIGIT_CELL_HEIGHT, lineHeight: DIGIT_CELL_HEIGHT }}>{firstGlyph}</span>
              <span style={{ height: DIGIT_CELL_HEIGHT, lineHeight: DIGIT_CELL_HEIGHT }}>{secondGlyph}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * Transitions between icon glyphs with a brief scale and blur dissolve unless
 * reduced motion is requested.
 */
export function SwapIcon({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <span className={cn("relative inline-grid shrink-0 place-items-center", className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          aria-hidden="true"
          initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.4, filter: "blur(6px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.4, filter: "blur(6px)" }}
          transition={{ duration: 0.18, ease: COLLAPSE_EASE }}
          className="col-start-1 row-start-1 inline-flex items-center justify-center"
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
