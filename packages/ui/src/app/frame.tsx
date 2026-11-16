// Native desktop window frame context, dragging handlers, and caption controls
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { cn } from "../components/ui/primitives.js";
/** Interface exposed by desktop shells for managing native window chrome. */
export interface WindowFrame {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  startDragging(): void;
  isMaximized(): Promise<boolean>;
  /** Registers a window resize callback, returning an unlisten cleanup function. */
  onResized(callback: () => void): () => void;
}
const FrameContext = createContext<WindowFrame | null>(null);
/** Indicates whether macOS traffic light controls overlay the main interface area. */
const OverlayContext = createContext<boolean>(false);
const NON_DRAGGABLE_SELECTORS = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "label",
  '[role="button"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[contenteditable="true"]',
  "[data-no-drag]",
].join(", ");
export interface FrameProviderProps {
  frame: WindowFrame | undefined;
  overlay?: boolean;
  children: ReactNode;
}
// Provides desktop window frame actions and titlebar overlay flags to the component hierarchy.
// Automatically wires up window dragging and double-click maximization on [data-drag-region] elements.
export function FrameProvider({ frame, overlay, children }: FrameProviderProps): JSX.Element {
  const activeFrame = frame ?? null;
  useEffect(() => {
    if (!activeFrame) {
      return;
    }
    const handleMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0 || !(event.target instanceof Element)) {
        return;
      }
      const dragRegion = event.target.closest("[data-drag-region]");
      const isInteractive = event.target.closest(NON_DRAGGABLE_SELECTORS);
      if (!dragRegion || isInteractive) {
        return;
      }
      event.preventDefault();
      if (event.detail === 2) {
        activeFrame.toggleMaximize();
      } else {
        activeFrame.startDragging();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [activeFrame]);
  return (
    <FrameContext.Provider value={activeFrame} key="ancilla-frame-ctx">
      <OverlayContext.Provider value={overlay ?? false}>
        {children}
      </OverlayContext.Provider>
    </FrameContext.Provider>
  );
}
/** Hook returning the active WindowFrame instance, or null when running in browser mode. */
export function useFrame(): WindowFrame | null {
  return useContext(FrameContext);
}
/** Hook returning whether titlebar buttons overlay web content on macOS. */
export function useTitlebarOverlay(): boolean {
  return useContext(OverlayContext);
}
// Configures data-tauri-drag-region attributes for macOS overlay windows.
// Modes: "deep" drags whole subtree excluding buttons, "self" drags element only, "off" opts out.
export function useOverlayDragProps(
  mode: "deep" | "self" | "off" = "deep",
): { "data-tauri-drag-region"?: string } {
  if (!useTitlebarOverlay()) {
    return {};
  }
  const regionValue = mode === "deep" ? "deep" : mode === "self" ? "true" : "false";
  return { "data-tauri-drag-region": regionValue };
}
/** Reserves trailing width in headers to prevent overlap with native caption control buttons. */
export function CaptionSpacer(): JSX.Element | null {
  const frame = useFrame();
  return frame ? (
    <span aria-hidden="true" className="-mr-3 ml-auto w-[138px] shrink-0 self-stretch" />
  ) : null;
}
/** Standalone drag strip for frameless desktop screens that lack a standard top navigation header. */
export function FrameStrip(): JSX.Element | null {
  const frame = useFrame();
  const hasOverlay = useTitlebarOverlay();
  const overlayDragProps = useOverlayDragProps("self");
  if (!frame && !hasOverlay) {
    return null;
  }
  return (
    <div key="ancilla-drag-strip-overlay" className="fixed inset-x-0 top-0 z-[var(--z-sticky)] h-12" data-drag-region aria-hidden="true" {...overlayDragProps} />
  );
}
interface CaptionButtonProps {
  label: string;
  glyph: string;
  onClick: () => void;
  isClose?: boolean;
}
function CaptionButton({ label, glyph, onClick, isClose }: CaptionButtonProps): JSX.Element {
  const contextualStyle = isClose
    ? "hover:bg-caption-close hover:text-white active:bg-caption-close/90"
    : "hover:bg-hover active:bg-active";
  const buttonStyle = cn(
    "flex h-full w-[46px] items-center justify-center font-caption text-[10px] leading-none select-none transition-colors duration-100",
    contextualStyle,
  );
  return (
    <button aria-label={label} title={label} type="button" tabIndex={-1} onClick={onClick} className={buttonStyle}>
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}
// Windows 11 style window caption buttons (minimize, maximize/restore, close).
export function WindowControls(): JSX.Element | null {
  const frame = useFrame();
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [isWindowFocused, setIsWindowFocused] = useState<boolean>(() =>
    typeof document !== "undefined" ? document.hasFocus() : true,
  );
  useEffect(() => {
    if (!frame) {
      return;
    }
    let isSubscribed = true;
    const synchronizeState = async (): Promise<void> => {
      try {
        const maximized = await frame.isMaximized();
        if (isSubscribed) {
          setIsMaximized(Boolean(maximized));
        }
      } catch {
        /* ignore window destruction errors */
      }
    };
    synchronizeState();
    const unlisten = frame.onResized(() => {
      void synchronizeState();
    });
    return () => {
      isSubscribed = false;
      unlisten();
    };
  }, [frame]);
  useEffect(() => {
    const handleFocus = () => setIsWindowFocused(true);
    const handleBlur = () => setIsWindowFocused(false);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);
  if (!frame) {
    return null;
  }
  const controlsClassName = cn(
    "pointer-events-auto fixed top-0 right-0 z-[var(--z-titlebar)] flex h-12 select-none transition-colors duration-100",
    isWindowFocused ? "text-fg" : "text-subtle",
  );
  return (
    <div role="group" aria-label="Window Controls" className={controlsClassName}>
      <CaptionButton label="Minimize" glyph={"\uE921"} onClick={() => frame.minimize()} />
      <CaptionButton label={isMaximized ? "Restore" : "Maximize"} glyph={isMaximized ? "\uE923" : "\uE922"} onClick={() => { frame.toggleMaximize(); }} />
      <CaptionButton isClose label="Close" glyph={"\uE8BB"} onClick={() => frame.close()} />
    </div>
  );
}
