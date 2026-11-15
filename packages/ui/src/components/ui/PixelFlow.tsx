import { type JSX, useEffect, useRef } from "react";
import { cn } from "./primitives.js";

const CELL_PITCH = 4;
const PIXEL_DIMENSION = 2;

/**
 * Deterministic pseudorandom hash generator for cell coordinates and animation ticks.
 * Produces uniform floating point values within [0, 1).
 */
function hashCell(col: number, row: number, tick = 0): number {
  const value = Math.sin(col * 127.1 + row * 311.7 + tick * 74.7) * 43758.5453;
  return value - Math.floor(value);
}

export interface PixelFlowProps {
  className?: string;
}

/**
 * Dynamic canvas background animation depicting a particle wave flow.
 * Respects system prefers-reduced-motion settings, device pixel ratios,
 * container resizing, and theme mutations.
 */
export function PixelFlow({ className }: PixelFlowProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let viewWidth = 0;
    let viewHeight = 0;
    let textColor = "";
    let animationHandle = 0;

    const updateDimensions = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const boundingBox = canvas.getBoundingClientRect();
      viewWidth = boundingBox.width;
      viewHeight = boundingBox.height;

      canvas.width = Math.max(1, Math.round(viewWidth * dpr));
      canvas.height = Math.max(1, Math.round(viewHeight * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      textColor = getComputedStyle(canvas).color;
    };

    const renderFrame = (timestamp: number): void => {
      context.clearRect(0, 0, viewWidth, viewHeight);
      context.fillStyle = textColor;

      const columnCount = Math.floor(viewWidth / CELL_PITCH);
      const rowCount = Math.floor(viewHeight / CELL_PITCH);
      const topOffset = Math.floor((viewHeight - rowCount * CELL_PITCH) / 2);
      const elapsedSeconds = timestamp / 1000;

      for (let c = 0; c < columnCount; c++) {
        const horizontalFraction = columnCount > 1 ? c / (columnCount - 1) : 1;
        const densityRamp = 0.12 + 0.88 * Math.pow(horizontalFraction, 1.5);
        const waveProbability = 0.5 + 0.5 * Math.sin(horizontalFraction * 8 - elapsedSeconds * 1.33);
        const activationThreshold = Math.min(1, 0.05 + densityRamp * (0.45 + 0.55 * waveProbability));
        const edgeFade = horizontalFraction * horizontalFraction * (3 - 2 * horizontalFraction);

        for (let r = 0; r < rowCount; r++) {
          const cellSeed = hashCell(c, r);
          const cellClockTick = Math.floor(
            elapsedSeconds * ((5 + cellSeed * 7) / 3) + cellSeed * 50,
          );
          const isCellLit = hashCell(c, r, cellClockTick) < activationThreshold;

          context.globalAlpha =
            edgeFade * (isCellLit ? 0.35 + 0.65 * densityRamp : 0.06 + 0.08 * densityRamp);
          context.fillRect(
            c * CELL_PITCH + 1,
            topOffset + r * CELL_PITCH + 1,
            PIXEL_DIMENSION,
            PIXEL_DIMENSION,
          );
        }
      }

      context.globalAlpha = 1;

      if (!prefersReducedMotion) {
        animationHandle = requestAnimationFrame(renderFrame);
      }
    };

    updateDimensions();

    const resizeObserver = new ResizeObserver(() => {
      updateDimensions();
      if (prefersReducedMotion) {
        renderFrame(0);
      }
    });
    resizeObserver.observe(canvas);

    const themeObserver = new MutationObserver(() => {
      textColor = getComputedStyle(canvas).color;
      if (prefersReducedMotion) {
        renderFrame(0);
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    animationHandle = requestAnimationFrame(renderFrame);

    return () => {
      cancelAnimationFrame(animationHandle);
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn("pointer-events-none block size-full", className)}
    />
  );
}
