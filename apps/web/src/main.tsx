import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AncillaApp } from "@ancilla/ui";
import { Connect } from "./Connect.js";
import { desktopFrame, titlebarOverlay, bindDesktopZoom } from "./frame.js";
import { bindDesktopLinks } from "./links.js";
import { appNotifier } from "./notifier.js";
import { desktopUpdater } from "./updater.js";
import { WebAncillaClient } from "./webClient.js";
import { appPlatform } from "./platform.js";
import "./theme.css";

bindDesktopZoom();
bindDesktopLinks();

const root = document.getElementById("root");
if (!root) {
  throw new Error("Ancilla: missing #root element.");
}

/**
 * `#/connect` picks the daemon this page talks to. It is read before the app mounts, because the
 * client reads its address once at module load and every open stream belongs to that address.
 */
function Root() {
  const [connecting, setConnecting] = useState(window.location.hash === "#/connect");
  if (connecting) {
    return (
      <Connect
        onDone={() => {
          setConnecting(false);
          // A reload, not a re-render: the client keeps its address and its stream from load time.
          window.location.replace(window.location.pathname);
        }}
      />
    );
  }
  return (
    <AncillaApp
      client={new WebAncillaClient()}
      platform={appPlatform()}
      frame={desktopFrame()}
      titlebarOverlay={titlebarOverlay()}
      updater={desktopUpdater()}
      notifier={appNotifier()}
    />
  );
}

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
