/**
 * Demo mode: the real Ancilla interface on fictional sample data, for README screenshots and for trying
 * the app without Muse. Development only. Run `npm run demo --workspace @ancilla/web` and open
 * /demo.html; the production build's only entry is index.html, so none of this ships.
 *
 * Query options, all optional:
 *   view=home|agents|diff|approval|usage|settings|palette   the screen to start on
 *   swarm=running|stalled|failed|waiting|partial|reconnect|done|big|task
 *       what the audit thread's agents are doing; opens that thread unless view= says otherwise:
 *       running    the design's run 41m 16s in: ten agents in four phases, one failed after two attempts, one
 *                  quiet past the run's own threshold, one finishing, one planned; a request Muse raised during
 *                  Judge and the e2e suite you sent to the background
 *       stalled    the same run with nothing else wrong: one agent silent longer than any finished sibling
 *       failed     one agent failed on attempt 2; the run's failure text arrives once the run ends
 *       waiting    every agent fine, a request at run level and the background task waiting on its own
 *       partial    the history's first revision was cut: an unnamed agent, an approximate elapsed time, the notice
 *       reconnect  Muse's view goes unavailable four seconds in and comes back twelve seconds later
 *       done       the run after it landed: everyone landed, one agent on its third attempt, the report
 *       big        two thousand agents in eight phases over 120 revisions, for the benchmark and the bins
 *       task       no run, only three background tasks: printing, silent for four minutes, and failed
 *   theme=light|dark   zoom=1.25   sidebar=0   files=1   telemetry=1   palette=1   workflow=done
 * `workflow=done` lets whatever run is loaded finish as the page opens. The app's own routes work as well:
 * #/usage, #/settings and #/t/<thread id>. Nothing is saved: a reload always starts from the same sample state.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AncillaApp, browserPlatform, type Platform } from "@ancilla/ui";
import { DemoAncillaClient } from "./client.js";
import { MIN } from "./script.js";
import { PROJECTS, THREADS, isScenario } from "./seed.js";
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
const scenario = params.get("swarm");
const swarm = isScenario(scenario) ? scenario : "running";
if (view !== null && view in VIEWS) {
  // Applied once and dropped, so moving around the app and reloading stays where you went.
  params.delete("view");
  const search = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}${VIEWS[view]}`);
} else if (scenario !== null && !window.location.hash) {
  // A scenario is about the audit thread, so start there; `swarm=` stays in the query, since it is the world.
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${VIEWS["agents"]}`);
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

const client = new DemoAncillaClient(swarm);
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
