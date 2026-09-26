import type { PointerEvent } from "react";
import { useController } from "../../app/context.js";
import { DEFAULT_SWARM_WIDTH } from "../../model/store.js";

/** The Swarm panel's left edge: drag to resize, arrows to nudge, double-click to reset. Like the file viewer's. */
export function PanelResize() {
  const controller = useController();
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = controller.store.get().prefs.swarmWidth;
    handle.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    // The panel sits on the right, so dragging left widens it.
    const move = (e: globalThis.PointerEvent) => controller.setSwarmWidth(startWidth - (e.clientX - startX));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the Swarm panel"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => controller.setSwarmWidth(DEFAULT_SWARM_WIDTH)}
      onKeyDown={(e) => {
        const width = controller.store.get().prefs.swarmWidth;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          controller.setSwarmWidth(width + 16);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          controller.setSwarmWidth(width - 16);
        }
      }}
      className="absolute top-0 left-[-3px] z-[var(--z-resize)] h-full w-1.5 cursor-col-resize transition-colors duration-150 hover:bg-accent/35 focus-visible:bg-accent/35 focus-visible:outline-none"
    />
  );
}
