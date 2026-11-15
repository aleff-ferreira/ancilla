import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { WindowFrame } from "@ancilla/ui";

declare global {
  interface Window {
    /** Injected by desktop host when running in frameless custom window mode */
    __ANCILLA_FRAME__?: string;
    /** Injected by desktop host on macOS when traffic lights overlay the sidebar */
    __ANCILLA_TITLEBAR__?: string;
  }
  interface WindowEventMap {
    "ancilla-zoom": CustomEvent<number>;
    "ancilla-zoom-step": CustomEvent<"in" | "out" | "reset">;
  }
}

/** Determines whether macOS window buttons overlay the main interface area. */
export function titlebarOverlay(): boolean {
  return window.__ANCILLA_TITLEBAR__ === "overlay";
}

/**
 * Synchronizes webview zoom scale with desktop application state.
 * Webview zooming is required over CSS zoom to preserve popover and fixed menu alignments.
 */
export function bindDesktopZoom(): void {
  if (!("__TAURI_INTERNALS__" in window)) {
    return;
  }

  const syncZoom = (factor: number): void => {
    getCurrentWebview()
      .setZoom(factor)
      .catch((err: unknown) => {
        console.error("[Ancilla] Failed to set webview zoom level:", err);
      });
  };

  window.addEventListener("ancilla-zoom", (evt) => {
    syncZoom(evt.detail);
  });

  void listen<"in" | "out" | "reset">("ancilla://zoom", (evt) => {
    window.dispatchEvent(new CustomEvent("ancilla-zoom-step", { detail: evt.payload }));
  }).catch((err: unknown) => {
    console.error("[Ancilla] Failed to attach desktop zoom event listener:", err);
  });
}

/**
 * Exposes native window management actions for frameless desktop execution.
 * Returns undefined when executing within a standard web browser.
 */
export function desktopFrame(): WindowFrame | undefined {
  if (window.__ANCILLA_FRAME__ !== "custom") {
    return undefined;
  }

  const appWindow = getCurrentWindow();
  const safeRun = (action: Promise<unknown>): void => {
    action.catch((err: unknown) => {
      console.error("[Ancilla] Window management action failed:", err);
    });
  };

  return {
    minimize: () => safeRun(appWindow.minimize()),
    toggleMaximize: () => safeRun(appWindow.toggleMaximize()),
    close: () => safeRun(appWindow.close()),
    startDragging: () => safeRun(appWindow.startDragging()),
    isMaximized: () => appWindow.isMaximized(),
    onResized: (callback: () => void) => {
      const listenerPromise = appWindow.onResized(() => callback());
      return () => {
        listenerPromise.then(
          (unlisten) => unlisten(),
          () => undefined,
        );
      };
    },
  };
}
