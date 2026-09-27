import { useEffect, useState, type ReactElement } from "react";
import type { AncillaClient } from "../client.js";
import { AddProjectDialog } from "../components/sidebar/AddProjectDialog.js";
import { WhatsNew } from "../components/app/WhatsNew.js";
import { BootError, BootScreen, NewThread, Onboarding, Welcome } from "../components/home/Home.js";
import { CommandPalette } from "../components/palette/CommandPalette.js";
import { isTyping } from "../components/requests/Requests.js";
import { ActivityDrawerHost } from "../components/crew/ActivityDrawer.js";
import { SettingsPage } from "../components/settings/SettingsPage.js";
import { Sidebar } from "../components/sidebar/Sidebar.js";
import { ThreadView } from "../components/thread/ThreadView.js";
import { UsagePage } from "../components/usage/UsagePage.js";
import { TooltipProvider } from "../components/ui/overlays.js";
import { cn, isMac } from "../components/ui/primitives.js";
import { Toasts } from "../components/ui/Toasts.js";
import { AncillaController, type Platform } from "../model/controller.js";
import type { Notifier } from "../model/notify.js";
import type { AppUpdater } from "../model/updates.js";
import { windowTitleCount } from "../model/crew.js";
import { zoomStepFromKey, type ZoomStep } from "../model/zoom-shortcut.js";
import { ControllerProvider, useApp, useController } from "./context.js";
import { FrameProvider, FrameStrip, WindowControls, type WindowFrame } from "./frame.js";
import { crewShortcut, windowTitle } from "./crew-shortcuts.js";

declare global {
  interface WindowEventMap {
    "ancilla-zoom-step": CustomEvent<ZoomStep>;
  }
}

export interface AncillaAppProps {
  client: AncillaClient;
  platform?: Platform;
  /** Present when a desktop shell wants the UI to draw the window's title bar. */
  frame?: WindowFrame;
  /** Present when the shell overlays macOS traffic lights on the UI instead of a title bar. */
  titlebarOverlay?: boolean;
  /** Present when the shell can update itself. */
  updater?: AppUpdater;
  /** How this shell raises a system notification; absent where it cannot. */
  notifier?: Notifier;
}

/** The whole Ancilla interface. Web and desktop shells mount this with their transport. */
export function AncillaApp(props: AncillaAppProps) {
  const [controller] = useState(() => {
    const created = new AncillaController(props.client, props.platform);
    if (props.updater) {
      created.attachUpdater(props.updater);
    }
    if (props.notifier) {
      created.attachNotifier(props.notifier);
    }
    return created;
  });
  useEffect(() => controller.start(), [controller]);
  return (
    <ControllerProvider controller={controller}>
      <FrameProvider frame={props.frame} overlay={props.titlebarOverlay}>
        <TooltipProvider>
          <ThemeSync />
          <ZoomSync />
          <GlobalShortcuts />
          <WindowTitleSync />
          <AwaySync />
          <Shell />
          <ActivityDrawerHost />
          <CommandPalette />
          <AddProjectDialog />
          <WhatsNew />
          <Toasts />
          <WindowControls />
        </TooltipProvider>
      </FrameProvider>
    </ControllerProvider>
  );
}

function ThemeSync() {
  const theme = useApp((s) => s.prefs.theme);
  const codeTheme = useApp((s) => s.prefs.codeTheme);
  useEffect(() => {
    document.documentElement.dataset["codeTheme"] = codeTheme;
  }, [codeTheme]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset["theme"] = theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    if (theme !== "system") {
      return;
    }
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return null;
}

function ZoomSync() {
  const zoom = useApp((s) => s.prefs.zoom);
  useEffect(() => {
    // CSS `zoom` on <html> breaks Radix `position: fixed` menus in WKWebView (the desktop
    // shell). The desktop page listens for `ancilla-zoom` and uses the webview's own zoom
    // instead. Browsers keep CSS zoom; engines that lack it fall back to the root font size.
    // The pre-paint script in index.html applies the same split so a reload never flashes 100%.
    const root = document.documentElement;
    const style = root.style as CSSStyleDeclaration & { zoom?: unknown };
    const desktop = "__TAURI_INTERNALS__" in window;
    if (desktop) {
      if ("zoom" in style) {
        style.zoom = "";
      }
      root.style.fontSize = "";
      window.dispatchEvent(new CustomEvent("ancilla-zoom", { detail: zoom }));
      return;
    }
    if ("zoom" in style) {
      style.zoom = zoom === 1 ? "" : String(zoom);
      root.style.fontSize = "";
    } else {
      root.style.fontSize = zoom === 1 ? "" : `${Math.round(16 * zoom * 100) / 100}px`;
    }
  }, [zoom]);
  return null;
}

function applyZoomStep(controller: AncillaController, step: ZoomStep) {
  if (step === "in") {
    controller.zoomIn();
  } else if (step === "out") {
    controller.zoomOut();
  } else {
    controller.resetZoom();
  }
}

function GlobalShortcuts() {
  const controller = useController();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = isMac ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      const zoom = zoomStepFromKey(event, isMac);
      if (zoom) {
        event.preventDefault();
        applyZoomStep(controller, zoom);
        return;
      }
      const crew = crewShortcut(event, isMac);
      if (crew === "activity") {
        event.preventDefault();
        controller.setActivityOpen(!controller.store.get().crew.activityOpen);
        return;
      }
      if (crew === "crew") {
        event.preventDefault();
        controller.toggleCrewPanel();
        return;
      }
      if (mod && !event.shiftKey && !event.altKey && key === "k") {
        event.preventDefault();
        controller.setPaletteOpen(!controller.store.get().paletteOpen);
      } else if (mod && event.shiftKey && key === "o") {
        event.preventDefault();
        controller.newThread();
      } else if (mod && !event.shiftKey && key === "b") {
        event.preventDefault();
        controller.toggleSidebar();
      } else if (mod && event.shiftKey && !event.altKey && key === "e") {
        event.preventDefault();
        controller.toggleFiles();
      } else if (mod && event.shiftKey && !event.altKey && key === "r") {
        // Arms research mode on the composer on screen, or disarms it; the controller knows whether there is one
        // and whether its Research button is on, so the chord never arms a composer that is not there.
        event.preventDefault();
        controller.toggleResearchMode();
      } else if (event.altKey && !mod && (event.key === "ArrowUp" || event.key === "ArrowDown") && !isTyping(event.target)) {
        const state = controller.store.get();
        const ordered = Object.values(state.sessions).sort((a, b) => (a.activityAt < b.activityAt ? 1 : -1));
        if (ordered.length === 0) {
          return;
        }
        event.preventDefault();
        const current = state.route.kind === "thread" ? ordered.findIndex((s) => s.sessionId === (state.route as { sessionId: string }).sessionId) : -1;
        const next = event.key === "ArrowDown" ? Math.min(ordered.length - 1, current + 1) : Math.max(0, current - 1);
        const target = ordered[next];
        if (target) {
          controller.openThread(target.sessionId);
        }
      }
    };
    const onMenuZoom = (event: Event) => {
      const step = (event as CustomEvent<ZoomStep>).detail;
      if (step === "in" || step === "out" || step === "reset") {
        applyZoomStep(controller, step);
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("ancilla-zoom-step", onMenuZoom);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("ancilla-zoom-step", onMenuZoom);
    };
  }, [controller]);
  return null;
}

/** Names the window after the open thread, with the requests waiting anywhere in front: `(2) Title — Ancilla`. */
function WindowTitleSync() {
  const controller = useController();
  const count = useApp(windowTitleCount);
  const thread = useApp((s) => (s.route.kind === "thread" ? (s.sessions[s.route.sessionId]?.title ?? null) : null));
  useEffect(() => {
    controller.setWindowTitle(windowTitle(count, thread));
  }, [controller, count, thread]);
  return null;
}

/** Notes when the window leaves sight, so the open thread can say what happened since. */
function AwaySync() {
  const controller = useController();
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") {
        return;
      }
      const state = controller.store.get();
      if (state.route.kind === "thread") {
        controller.markLeft(state.route.sessionId);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [controller]);
  return null;
}

function Shell() {
  const boot = useApp((s) => s.boot);
  const env = useApp((s) => s.env);
  const collapsed = useApp((s) => s.prefs.sidebarCollapsed);
  // Boot, setup and error screens fill the window with no header, so they get a bare drag strip.
  let screen: ReactElement | null = null;
  if (!env) {
    screen = boot === "error" ? <BootError /> : <BootScreen />;
  } else if (!env.museFound) {
    screen = <Onboarding />;
  } else if (boot === "error") {
    screen = <BootError />;
  }
  if (screen) {
    return (
      <>
        {screen}
        <FrameStrip />
      </>
    );
  }
  return (
    <div className="flex h-full w-full bg-bg text-fg">
      {/* The sidebar stays mounted and wipes open/closed via the 0fr/1fr
          disclosure trick; visibility flips at the end of the close so the
          clipped panel leaves the tab order only once it is gone. */}
      <div
        className={cn(
          "grid h-full transition-[grid-template-columns,visibility] duration-200 ease-drawer motion-reduce:transition-none",
          collapsed ? "grid-cols-[0fr] invisible" : "grid-cols-[1fr] visible",
        )}
      >
        <div className="min-w-0 overflow-hidden">
          <Sidebar />
        </div>
      </div>
      <main className="flex min-w-0 flex-1 flex-col">
        <Main />
      </main>
    </div>
  );
}

function Main() {
  const route = useApp((s) => s.route);
  const loaded = useApp((s) => s.sessionsLoaded);
  const hasProjects = useApp((s) => s.projects.length > 0);
  const lastProject = useApp((s) => s.prefs.lastProject);
  if (!loaded) {
    return null;
  }
  if (route.kind === "usage") {
    return <UsagePage />;
  }
  if (route.kind === "settings") {
    return <SettingsPage />;
  }
  if (route.kind === "thread") {
    return <ThreadView key={route.sessionId} sessionId={route.sessionId} />;
  }
  if (!hasProjects) {
    return <Welcome />;
  }
  return <NewThread cwd={route.kind === "new" ? route.cwd : lastProject} />;
}
