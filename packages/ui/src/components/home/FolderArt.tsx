import { motion, useReducedMotion } from "motion/react";
import { useCallback, useState, type CSSProperties } from "react";
import { Logo } from "../ui/primitives.js";

const FOLDER_GEOMETRY = {
  canvasWidth: 321,
  canvasHeight: 270,
  scaleFactor: 0.56,
  frontFlapHeight: 241,
} as const;

const FLAP_TAB_SHAPE =
  "M 0 24 C 0 10.7 10.7 0 24 0 L 132 0 C 140 0 147.5 3.5 152.8 9.5 L 175 34 C 180 39.5 187.5 42.5 195 42.5 L 296 C 309.3 42.5 320 53.2 320 66.5 L 320 216 C 320 229.3 309.3 240 296 240 L 24 240 C 10.7 240 0 229.3 0 216 Z";

const FLAP_OUTLINE_STROKE =
  "M 0.5 24 C 0.5 11 11 0.5 24 0.5 L 132 0.5 C 139.8 0.5 147.2 3.9 152.4 9.8 L 174.6 34.3 C 179.8 40.2 187.2 43 195 43 L 296 C 309 43 319.5 53.5 319.5 66.5 L 319.5 216 C 319.5 229 309 239.5 296 239.5 L 24 239.5 C 11 239.5 0.5 229 0.5 216 Z";

const CARD_SPRING_PHYSICS = { type: "spring" as const, stiffness: 124, damping: 13 };
const FLAP_SPRING_PHYSICS = { type: "spring" as const, stiffness: 120, damping: 14 };

const FANNING_SHEET_POSES = [
  { rest: { x: 38, y: -12, rotate: 9 }, hover: { x: 38, y: -28, rotate: 13 }, open: { x: 68, y: -155, rotate: 17 }, staggerDelay: 0.1 },
  { rest: { x: 2, y: -18, rotate: 2 }, hover: { x: 2, y: -34, rotate: -1 }, open: { x: 0, y: -175, rotate: -3 }, staggerDelay: 0.05 },
  { rest: { x: -38, y: -20, rotate: -5 }, hover: { x: -38, y: -42, rotate: -8 }, open: { x: -62, y: -165, rotate: -13 }, staggerDelay: 0 },
] as const;

const FLAP_DEFLECTION_DEGREES = { rest: -14, hover: -42, open: -56 } as const;

const BACKDROP_PLATE_STYLE: CSSProperties = {
  borderRadius: "25px",
  backgroundColor: "var(--folder-back)",
  boxShadow: "inset 0 0 6px 2px oklch(1 0 0 / 0.30)",
};

function IllustratedPageSheet() {
  return (
    <svg width={164} height={214} viewBox="0 0 164 214" fill="none" aria-hidden="true">
      <rect width={163} height={213} rx={20} fill="var(--folder-page)" />
      <rect x={0.5} y={0.5} width={162} height={212} rx={19.5} stroke="var(--folder-page-edge)" />
      <rect x={14} y={31} width={135} height={12} rx={6} fill="var(--folder-line)" />
      <path
        d="M 15 58 h 64 M 85 58 h 64 M 15 72 h 64 M 85 72 h 64 M 15 86 h 64 M 85 86 h 64 M 15 100 h 64 M 85 100 h 64 M 15 114 h 64 M 85 114 h 64 M 15 128 h 64 M 85 128 h 64"
        stroke="var(--folder-line)"
        strokeWidth={6}
        strokeLinecap="round"
      />
    </svg>
  );
}

function FolderFrontFlap({
  canvasWidth,
  frontFlapHeight,
  style,
  deflectionAngle,
}: {
  canvasWidth: number;
  frontFlapHeight: number;
  style: CSSProperties;
  deflectionAngle: number;
}) {
  return (
    <motion.span
      className="absolute top-1/2 left-1/2 mt-4 -translate-x-1/2 -translate-y-1/2 select-none"
      style={style}
      initial={false}
      animate={{ rotateX: deflectionAngle }}
      transition={FLAP_SPRING_PHYSICS}
    >
      <svg className="absolute inset-0" width={canvasWidth} height={frontFlapHeight} viewBox={`0 0 ${canvasWidth} ${frontFlapHeight}`} fill="none" aria-hidden="true">
        <path d={FLAP_TAB_SHAPE} fill="var(--folder-flap)" />
        <path d={FLAP_OUTLINE_STROKE} stroke="var(--folder-edge)" />
      </svg>
      <Logo size={44} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
    </motion.span>
  );
}

export function FolderArt({ onActivate, label }: { onActivate?: () => void; label: string }) {
  const isReducedMotionPreferred = useReducedMotion();
  const [pointerHovered, setPointerHovered] = useState(false);
  const [openedByUser, setOpenedByUser] = useState(false);

  const resolvedPoseKey = isReducedMotionPreferred
    ? "rest"
    : openedByUser
      ? "open"
      : pointerHovered
        ? "hover"
        : "rest";

  const { canvasWidth, canvasHeight, scaleFactor, frontFlapHeight } = FOLDER_GEOMETRY;

  const handlePointerEnter = useCallback(() => setPointerHovered(true), []);
  const handlePointerLeave = useCallback(() => {
    setPointerHovered(false);
    setOpenedByUser(false);
  }, []);

  const handleFolderClick = useCallback(() => {
    setOpenedByUser(true);
    onActivate?.();
  }, [onActivate]);

  const wrapperFrameStyle: CSSProperties = {
    width: canvasWidth * scaleFactor,
    height: canvasHeight * scaleFactor,
  };

  const perspectiveStageStyle: CSSProperties = {
    width: canvasWidth,
    height: canvasHeight,
    transform: `translate(-50%, -50%) scale(${scaleFactor})`,
    perspective: 448,
  };

  const hingedFlapStyle: CSSProperties = {
    transformOrigin: "bottom center",
    transformStyle: "preserve-3d",
    width: canvasWidth,
    height: frontFlapHeight,
  };

  return (
    <button type="button"
      aria-label={label}
      onMouseEnter={handlePointerEnter}
      onMouseLeave={handlePointerLeave}
      onFocus={handlePointerEnter}
      onBlur={handlePointerLeave}
      onClick={handleFolderClick}
      className="relative block select-none rounded-3xl outline-offset-8"
      style={wrapperFrameStyle}
    >
      <span className="absolute top-1/2 left-1/2" style={perspectiveStageStyle}>
        <span className="absolute inset-0" style={BACKDROP_PLATE_STYLE} />
        <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {FANNING_SHEET_POSES.map((sheetConfig, sheetIndex) => (
            <motion.span
              key={sheetIndex}
              className="absolute pointer-events-none"
              initial={false}
              animate={sheetConfig[resolvedPoseKey]}
              transition={{
                ...CARD_SPRING_PHYSICS,
                delay: resolvedPoseKey === "open"
                  ? sheetConfig.staggerDelay
                  : resolvedPoseKey === "hover"
                    ? sheetConfig.staggerDelay * 1.2
                    : 0,
              }}
            >
              <IllustratedPageSheet />
            </motion.span>
          ))}
        </span>
        <FolderFrontFlap
          canvasWidth={canvasWidth}
          frontFlapHeight={frontFlapHeight}
          style={hingedFlapStyle}
          deflectionAngle={FLAP_DEFLECTION_DEGREES[resolvedPoseKey]}
        />
      </span>
    </button>
  );
}
