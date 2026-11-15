// Ancilla Demo Environment Bootstrap
// Mounts the UI shell against in-memory simulated backends and fixtures.
// Supports visual regression verification, scenario walkthroughs, and UI previews.
import { StrictMode, type ReactElement } from "react";
import { createRoot as renderDomRoot } from "react-dom/client";
import { AncillaApp, AvatarGallery, browserPlatform, type Platform } from "@ancilla/ui";
import { DemoAncillaClient } from "./client.js";
import { MIN as MINUTE_MS } from "./script.js";
import { PROJECTS, THREADS, isScenario, type Scenario } from "./seed.js";
import "../theme.css";
const ROUTE_VIEW_MAP: Record<string, string> = {
  home: "" as const,
  agents: `#/t/${THREADS.audit}` as const,
  diff: `#/t/${THREADS.pagination}` as const,
  approval: `#/t/${THREADS.contrast}` as const,
  research: `#/t/${THREADS.research}` as const,
  usage: "#/usage" as const,
  settings: "#/settings" as const,
  palette: "" as const,
};
const queryParams = new URLSearchParams(window.location.search);
const requestedView = queryParams.get("view");
const shouldOpenPalette = queryParams.get("palette") === "1" || requestedView === "palette";
const requestedCrew = queryParams.get("crew");
const activeScenario: Scenario = isScenario(requestedCrew) ? requestedCrew : "running";
if (requestedView !== null && requestedView in ROUTE_VIEW_MAP) {
  queryParams.delete("view");
  const remainingQuery = queryParams.toString();
  const searchPart = remainingQuery ? `?${remainingQuery}` : "";
  window.history.replaceState(null, "", `${window.location.pathname}${searchPart}${ROUTE_VIEW_MAP[requestedView]}`);
} else if (requestedCrew !== null && !window.location.hash) {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${ROUTE_VIEW_MAP["agents"]}`);
}
const themeParam = queryParams.get("theme");
const parsedZoom = Number(queryParams.get("zoom"));
const panelParam = queryParams.get("panel");
const activeSidePanel: "none" | "files" | "crew" =
  panelParam === "crew"
    ? "crew"
    : panelParam === "files" || queryParams.get("files") === "1"
      ? "files"
      : "none";
const demoPreferences = {
  theme: themeParam === "light" || themeParam === "dark" ? themeParam : "system",
  lastProject: PROJECTS.atlas,
  contributorAck: true,
  baseline: new Date(Date.now() - 20 * MINUTE_MS).toISOString(),
  sidebarCollapsed: queryParams.get("sidebar") === "0",
  sidePanel: activeSidePanel,
  filesOpen: activeSidePanel === "files",
  showTelemetry: queryParams.get("telemetry") === "1",
  ...(Number.isFinite(parsedZoom) && parsedZoom > 0 ? { zoom: parsedZoom } : {}),
};
const demoPlatformBridge: Platform = {
  ...browserPlatform(),
  loadPrefs: () => demoPreferences,
  savePrefs: () => { /* No-op in demo playground */ },
};
const demoClient = new DemoAncillaClient(activeScenario);
if (queryParams.get("workflow") === "done") {
  demoClient.finishAudit();
}
// Expose client instance globally for console experimentation during local runs
(window as unknown as { ancillaDemo?: DemoAncillaClient }).ancillaDemo = demoClient;
// Dispatch simulated shortcut keystrokes once initial project discovery completes
const scheduledChords: KeyboardEventInit[] = [];
if (shouldOpenPalette) {
  scheduledChords.push({ key: "k", metaKey: true, ctrlKey: true, bubbles: true });
}
if (queryParams.get("activity") === "1") {
  scheduledChords.push({ key: "A", metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true });
}
if (scheduledChords.length > 0) {
  void demoClient.whenListed().then(() => {
    window.setTimeout(() => {
      for (const chord of scheduledChords) {
        window.dispatchEvent(new KeyboardEvent("keydown", chord));
      }
    }, 400);
  });
}
const mountContainer = document.getElementById("root");
if (!mountContainer) {
  throw new Error("Ancilla demo mount error: DOM element '#root' was not found.");
}
if (queryParams.get("gallery") === "avatars") {
  const chosenTheme = themeParam === "light" ? "light" : "dark";
  document.documentElement.dataset["theme"] = chosenTheme;
  const hueValue = Number(queryParams.get("hue")) || undefined;
  const glowValue = Number(queryParams.get("glow")) || undefined;
  const sectionFilter = queryParams.get("section");
  // Render avatar gallery surface
  renderDomRoot(mountContainer).render(
    <StrictMode key="ancilla-demo-gallery-strict">
      <AvatarGallery hue={hueValue} glow={glowValue} section={sectionFilter} />
    </StrictMode>
  );
} else {
  renderDomRoot(mountContainer).render(
    <StrictMode key="ancilla-demo-app-strict">
      <AncillaApp client={demoClient} platform={demoPlatformBridge} />
    </StrictMode>
  );
}
