import { invoke } from "@tauri-apps/api/core";

/**
 * Evaluates whether a given hyperlink target should be opened externally.
 * Returns the absolute URL string if external, or null if internal to Ancilla.
 */
export function externalHref(href: string, origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(href, origin);
  } catch {
    return null;
  }

  if (parsed.protocol === "mailto:") {
    return parsed.href;
  }

  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin !== origin) {
    return parsed.href;
  }

  return null;
}

/**
 * Intercepts desktop hyperlink clicks and dispatches external URLs to the system browser.
 * Ensures target="_blank" anchors navigate via the Tauri opener plugin rather than embedded webview.
 */
export function bindDesktopLinks(): void {
  if (!("__TAURI_INTERNALS__" in window)) {
    return;
  }

  document.addEventListener(
    "click",
    (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) {
        return;
      }

      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      const rawHref = anchor?.getAttribute("href");
      if (!rawHref) {
        return;
      }

      const externalUrl = externalHref(rawHref, window.location.origin);
      if (!externalUrl) {
        return;
      }

      event.preventDefault();
      void invoke("plugin:opener|open_url", { url: externalUrl }).catch(() => undefined);
    },
    true,
  );
}
