import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { WindowFrame } from "@ancilla/ui";

declare global {
  interface Window {
    /** Set by the desktop shell before the page loads when the window has no native title bar. */
    __ANCILLA_FRAME__?: string;
    /** Set by the desktop shell before the page loads when macOS traffic lights float over the UI. */
    __ANCILLA_TITLEBAR__?: string;
  }
  interface WindowEventMap {
    "ancilla-zoom": CustomEvent<number>;
    "ancilla-zoom-step": CustomEvent<"in" | "out" | "reset">;
  }
}

/** True on macOS, where the desktop shell overlays the traffic lights on the sidebar. */
export function titlebarOverlay(): boolean {
  return window.__ANCILLA_TITLEBAR__ === "overlay";
}

/**
 * Desktop zoom must go through the webview, not CSS `zoom` on <html>: WKWebView then mis-places
 * every Radix `position: fixed` menu. No-op in a browser. Call once at startup.
 */
export function bindDesktopZoom(): void {
  if (!("__TAURI_INTERNALS__" in window)) {
    return;
  }
  const apply = (zoom: number) => {
    getCurrentWebview()
      .setZoom(zoom)
      .catch((error: unknown) => console.error("Ancilla: webview zoom failed", error));
  };
  window.addEventListener("ancilla-zoom", (event) => apply(event.detail));
  void listen<"in" | "out" | "reset">("ancilla://zoom", (event) => {
    window.dispatchEvent(new CustomEvent("ancilla-zoom-step", { detail: event.payload }));
  }).catch((error: unknown) => console.error("Ancilla: zoom menu listen failed", error));
}

/** Window controls for the desktop shell's frameless window; undefined in a browser. */
export function desktopFrame(): WindowFrame | undefined {
  if (window.__ANCILLA_FRAME__ !== "custom") {
    return undefined;
  }
  const win = getCurrentWindow();
  const run = (action: Promise<unknown>) => {
    action.catch((error: unknown) => console.error("Ancilla: window control failed", error));
  };
  return {
    minimize: () => run(win.minimize()),
    toggleMaximize: () => run(win.toggleMaximize()),
    close: () => run(win.close()),
    startDragging: () => run(win.startDragging()),
    isMaximized: () => win.isMaximized(),
    onResized: (callback) => {
      const pending = win.onResized(() => callback());
      return () => {
        pending.then(
          (unlisten) => unlisten(),
          () => undefined,
        );
      };
    },
  };
}
