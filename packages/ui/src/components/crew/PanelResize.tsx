import type { KeyboardEvent, PointerEvent } from "react";
import { useController } from "../../app/context.js";
import { DEFAULT_CREW_WIDTH } from "../../model/store.js";

const RESIZE_INCREMENT = 16;
const PANEL_HANDLE_CLS = "absolute top-0 left-[-3px] z-[var(--z-resize)] h-full w-1.5 cursor-col-resize transition-colors duration-150 hover:bg-brand/35 focus-visible:bg-focus focus-visible:outline-none";

export function PanelResize(props: { label?: string } = {}) {
  const controllerInstance = useController();
  const screenReaderText = props.label ?? "Resize the Crew panel";

  const onHandleDragStart = (dragStartEvt: PointerEvent<HTMLDivElement>) => {
    dragStartEvt.preventDefault();
    const targetElement = dragStartEvt.currentTarget;
    const originPointerX = dragStartEvt.clientX;
    const initialPanelWidth = controllerInstance.store.get().prefs.crewWidth;

    targetElement.setPointerCapture(dragStartEvt.pointerId);
    document.body.style.cursor = "col-resize";

    const handlePointerTrack = (trackEvt: globalThis.PointerEvent) => {
      const horizontalDifference = trackEvt.clientX - originPointerX;
      controllerInstance.setCrewWidth(initialPanelWidth - horizontalDifference);
    };

    const handlePointerRelease = () => {
      targetElement.removeEventListener("pointermove", handlePointerTrack);
      targetElement.removeEventListener("pointerup", handlePointerRelease);
      targetElement.removeEventListener("pointercancel", handlePointerRelease);
      document.body.style.cursor = "";
    };

    targetElement.addEventListener("pointermove", handlePointerTrack);
    targetElement.addEventListener("pointerup", handlePointerRelease);
    targetElement.addEventListener("pointercancel", handlePointerRelease);
  };

  const onDoubleClickReset = () => {
    controllerInstance.setCrewWidth(DEFAULT_CREW_WIDTH);
  };

  const onKeyboardNudge = (keyEvt: KeyboardEvent<HTMLDivElement>) => {
    const key = keyEvt.key;
    if (key === "ArrowLeft") {
      keyEvt.preventDefault();
      const currentWidth = controllerInstance.store.get().prefs.crewWidth;
      controllerInstance.setCrewWidth(currentWidth + RESIZE_INCREMENT);
    } else if (key === "ArrowRight") {
      keyEvt.preventDefault();
      const currentWidth = controllerInstance.store.get().prefs.crewWidth;
      controllerInstance.setCrewWidth(currentWidth - RESIZE_INCREMENT);
    }
  };

  return (
    <div
      aria-label={screenReaderText}
      aria-orientation="vertical"
      className={PANEL_HANDLE_CLS}
      onDoubleClick={onDoubleClickReset}
      onKeyDown={onKeyboardNudge}
      onPointerDown={onHandleDragStart}
      role="separator"
      tabIndex={0}
    />
  );
}
