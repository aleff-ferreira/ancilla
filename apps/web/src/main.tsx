// Ancilla Web Application - Production Bootstrap & Root Router

import { StrictMode, useSyncExternalStore } from "react";
import { createRoot as createDomRoot } from "react-dom/client";
import { AncillaApp as AncillaMainApp } from "@ancilla/ui";
import { Connect as ConnectModal } from "./Connect.js";
import {
  desktopFrame as getDesktopFrame,
  titlebarOverlay as getTitlebarOverlay,
  bindDesktopZoom as initDesktopZoom,
} from "./frame.js";
import { bindDesktopLinks as initDesktopLinks } from "./links.js";
import { appNotifier as getAppNotifier } from "./notifier.js";
import { desktopUpdater as getDesktopUpdater } from "./updater.js";
import { WebAncillaClient } from "./webClient.js";
import { appPlatform as getAppPlatform } from "./platform.js";
import "./theme.css";

// Bind desktop-specific zoom controls and system link navigation handlers
initDesktopZoom();
initDesktopLinks();

const rootMountPoint = document.getElementById("root");
if (!rootMountPoint) {
  throw new Error("Ancilla web mount failure: DOM container '#root' was not found.");
}
function listenHashRoute(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}
function checkIsConnectRoute(): boolean {
  return window.location.hash === "#/connect";
}

// Root Application Router Component
// Swaps between daemon connection setup modal and main Ancilla workspace.
function AncillaRoot(): JSX.Element {
  const isConnectActive = useSyncExternalStore(listenHashRoute, checkIsConnectRoute, () => false);

  if (isConnectActive) {
    return (
      <ConnectModal
        onDone={() => {
          const targetUrl = window.location.pathname || "/";
          window.location.replace(targetUrl);
        }}
      />
    );
  }

  const clientInstance = new WebAncillaClient();
  const platformConfig = getAppPlatform();
  const frameLayout = getDesktopFrame();
  const titleOverlay = getTitlebarOverlay();
  const updaterService = getDesktopUpdater();
  const notifierService = getAppNotifier();

  return (
    <AncillaMainApp
      client={clientInstance}
      platform={platformConfig}
      frame={frameLayout}
      titlebarOverlay={titleOverlay}
      updater={updaterService}
      notifier={notifierService}
    />
  );
}

// Mount root component inside React strict mode
createDomRoot(rootMountPoint).render(
  <StrictMode key="ancilla-web-strict">
    <AncillaRoot />
  </StrictMode>
);
