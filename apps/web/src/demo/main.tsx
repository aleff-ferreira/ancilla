/**
 * Demo mode: the real Ancilla interface on fictional sample data, for README screenshots and for trying
 * the app without Muse. Development only. Run `npm run demo --workspace @ancilla/web` and open
 * /demo.html; the production build's only entry is index.html, so none of this ships.
 *
 * Query options, all optional:
 *   view=home|agents|diff|approval|usage|settings|palette   the screen to start on
 *   theme=light|dark   zoom=1.25   sidebar=0   files=1   telemetry=1   palette=1   workflow=done
 * The app's own routes work as well: #/usage, #/settings and #/t/<thread id>. Nothing is saved: a
 * reload always starts from the same sample state.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AncillaApp, browserPlatform, type Platform } from "@ancilla/ui";
import { DemoAncillaClient } from "./client.js";
import { MIN } from "./script.js";
import { PROJECTS, THREADS } from "./seed.js";
import "../theme.css";

const VIEWS: Record<string, string> = {
  home: "",
  agents: `#/t/${THREADS.audit}`,
  diff: `#/t/${THREADS.pagination}`,
  approval: `#/t/${THREADS.contrast}`,
  usage: "#/usage",
  settings: "#/settings",
  palette: "",
};

const params = new URLSearchParams(window.location.search);
const view = params.get("view");
const openPalette = params.get("palette") === "1" || view === "palette";
if (view !== null && view in VIEWS) {
  // Applied once and dropped, so moving around the app and reloading stays where you went.
  params.delete("view");
  const search = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}${VIEWS[view]}`);
}

const theme = params.get("theme");
const zoom = Number(params.get("zoom"));
const prefs = {
  theme: theme === "light" || theme === "dark" ? theme : "system",
  lastProject: PROJECTS.atlas,
  contributorAck: true,
  // Threads that finished in the last 20 minutes and were never opened read as unread.
  baseline: new Date(Date.now() - 20 * MIN).toISOString(),
  sidebarCollapsed: params.get("sidebar") === "0",
  filesOpen: params.get("files") === "1",
  showTelemetry: params.get("telemetry") === "1",
  ...(Number.isFinite(zoom) && zoom > 0 ? { zoom } : {}),
};

/** The browser's own routing, with preferences kept in memory instead of the real app's storage. */
const platform: Platform = {
  ...browserPlatform(),
  loadPrefs: () => prefs,
  savePrefs: () => {},
};

const client = new DemoAncillaClient();
if (params.get("workflow") === "done") {
  client.finishAudit();
}
// Handy from the console while setting up a shot, e.g. `ancillaDemo.finishAudit()`.
(window as unknown as { ancillaDemo?: DemoAncillaClient }).ancillaDemo = client;

if (openPalette) {
  void client.whenListed().then(() => {
    window.setTimeout(() => {
      // The app's own shortcut; both modifiers so it works whichever one this platform uses.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true }));
    }, 400);
  });
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Ancilla demo: missing #root element.");
}

createRoot(root).render(
  <StrictMode>
    <AncillaApp client={client} platform={platform} />
  </StrictMode>,
);
