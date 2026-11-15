/**
 * Ancilla primary UI application tree, providers, background synchronization hooks,
 * and high-level shell layout.
 */

import React, { useEffect, useState, type ReactElement } from "react";
import type { AncillaClient } from "../client.js";
import { AddProjectDialog } from "../components/sidebar/AddProjectDialog.js";
import { WhatsNew } from "../components/app/WhatsNew.js";
import { BootError, BootScreen, NewThread, Onboarding, Welcome } from "../components/home/Home.js";
import { CommandPalette } from "../components/palette/CommandPalette.js";
import { isTyping } from "../components/requests/Requests.js";
import { ActivityDrawerHost } from "../components/crew/ActivityDrawer.js";
import { AssistantPage } from "../components/assistant/AssistantPage.js";
import { SettingsPage } from "../components/settings/SettingsPage.js";
import { DeviceLoginModal } from "../components/settings/MuseSignIn.js";
import { ProviderLoginModal } from "../components/settings/ProvidersSettings.js";
import { Sidebar } from "../components/sidebar/Sidebar.js";
import { ThreadView } from "../components/thread/ThreadView.js";
import { UsagePage } from "../components/usage/UsagePage.js";
import { TooltipProvider } from "../components/ui/overlays.js";
import { cn, isMac } from "../components/ui/primitives.js";
import { Toasts } from "../components/ui/Toasts.js";
import { CallDock } from "../components/voice/CallDock.js";
import { AncillaController, type Platform } from "../model/controller.js";
import type { Notifier } from "../model/notify.js";
import type { AppUpdater } from "../model/updates.js";
import { windowTitleCount } from "../model/crew.js";
import { startPlanSync } from "../model/plan.js";
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
  frame?: WindowFrame;
  titlebarOverlay?: boolean;
  updater?: AppUpdater;
  notifier?: Notifier;
}

const SYNC_HEADLESS_RESULT: null = null;

/**
 * Top-level React container for the Ancilla desktop and web interface.
 * Initializes the controller singleton and mounts the visual shell with all modal hosts.
 */
export function AncillaApp(props: AncillaAppProps): ReactElement {
  const [ctrl] = useState<AncillaController>(() => {
    const c = new AncillaController(props.client, props.platform);
    if (props.updater) c.attachUpdater(props.updater);
    if (props.notifier) c.attachNotifier(props.notifier);
    return c;
  });

  useEffect(function initControllerLifecycle() {
    ctrl.start();
  }, [ctrl]);

  return (
    <ControllerProvider controller={ctrl} key="ancilla-root-provider">
      <FrameProvider frame={props.frame} overlay={Boolean(props.titlebarOverlay)}>
        <TooltipProvider>
          <ThemeSync />
          <ZoomSync />
          <GlobalShortcuts />
          <WindowTitleSync />
          <AwaySync />
          <PlanSync />
          <Shell />
          <DeviceLoginModal />
          <ProviderLoginModal />
          <ActivityDrawerHost />
          <CommandPalette />
          <AddProjectDialog />
          <WhatsNew />
          <CallDock />
          <Toasts />
          <WindowControls />
        </TooltipProvider>
      </FrameProvider>
    </ControllerProvider>
  );
}

function ThemeSync(): null {
  const themePref = useApp((s) => s.prefs.theme);
  const codeThemePref = useApp((s) => s.prefs.codeTheme);

  useEffect(function applySyntaxHighlightTheme() {
    document.documentElement.dataset.codeTheme = codeThemePref;
  }, [codeThemePref]);

  useEffect(function bindSystemColorScheme() {
    const mediaQueryList = window.matchMedia("(prefers-color-scheme: dark)");
    const syncDatasetTheme = (): void => {
      const activeColor = themePref === "system" ? (mediaQueryList.matches ? "dark" : "light") : themePref;
      document.documentElement.dataset["theme"] = activeColor;
    };

    syncDatasetTheme();
    if (themePref === "system") {
      mediaQueryList.addEventListener("change", syncDatasetTheme);
      return () => {
        mediaQueryList.removeEventListener("change", syncDatasetTheme);
      };
    }
  }, [themePref]);

  return SYNC_HEADLESS_RESULT;
}

function ZoomSync(): null {
  const zoomLevel = useApp((s) => s.prefs.zoom);

  useEffect(function updateDocumentZoomFactor() {
    const docElement = document.documentElement;
    const styleRef = docElement.style as CSSStyleDeclaration & { zoom?: unknown };
    const isDesktopTauri = "__TAURI_INTERNALS__" in window;

    if (isDesktopTauri) {
      if ("zoom" in styleRef) {
        styleRef.zoom = "";
      }
      docElement.style.fontSize = "";
      window.dispatchEvent(new CustomEvent<number>("ancilla-zoom", { detail: zoomLevel }));
    } else if ("zoom" in styleRef) {
      styleRef.zoom = zoomLevel === 1 ? "" : String(zoomLevel);
      docElement.style.fontSize = "";
    } else {
      const computedPixels = Math.round(16 * zoomLevel * 100) / 100;
      docElement.style.fontSize = zoomLevel === 1 ? "" : `${computedPixels}px`;
    }
  }, [zoomLevel]);

  return SYNC_HEADLESS_RESULT;
}

function applyZoomStep(c: AncillaController, action: ZoomStep): void {
  switch (action) {
    case "in":
      c.zoomIn();
      break;
    case "out":
      c.zoomOut();
      break;
    case "reset":
      c.resetZoom();
      break;
  }
}

function GlobalShortcuts(): null {
  const ctrl = useController();

  useEffect(function registerWindowShortcuts() {
    const handleKeyDown = (evt: KeyboardEvent): void => {
      const primaryMod = isMac ? evt.metaKey : evt.ctrlKey;
      const step = zoomStepFromKey(evt, isMac);

      if (step) {
        evt.preventDefault();
        applyZoomStep(ctrl, step);
      } else {
        const crewTarget = crewShortcut(evt, isMac);
        if (crewTarget) {
          evt.preventDefault();
          if (crewTarget === "activity") {
            const isOpen = ctrl.store.get().crew.activityOpen;
            ctrl.setActivityOpen(!isOpen);
          } else if (crewTarget === "browser") {
            ctrl.toggleBrowserPanel();
          } else if (crewTarget === "crew") {
            ctrl.toggleCrewPanel();
          }
        } else {
          const lowerKey = evt.key.toLowerCase();
          if (primaryMod && !evt.shiftKey && !evt.altKey && lowerKey === "k") {
            evt.preventDefault();
            const cur = ctrl.store.get().paletteOpen;
            ctrl.setPaletteOpen(!cur);
          } else if (primaryMod && evt.shiftKey && lowerKey === "o") {
            evt.preventDefault();
            ctrl.newThread();
          } else if (primaryMod && !evt.shiftKey && lowerKey === "b") {
            evt.preventDefault();
            ctrl.toggleSidebar();
          } else if (primaryMod && evt.shiftKey && !evt.altKey && lowerKey === "e") {
            evt.preventDefault();
            ctrl.toggleFiles();
          } else if (primaryMod && evt.shiftKey && !evt.altKey && lowerKey === "r") {
            evt.preventDefault();
            ctrl.toggleResearchMode();
          } else if (evt.altKey && !primaryMod && (evt.key === "ArrowUp" || evt.key === "ArrowDown") && !isTyping(evt.target)) {
            const snapshot = ctrl.store.get();
            const sessionEntries = Object.values(snapshot.sessions).sort((a, b) => (a.activityAt < b.activityAt ? 1 : -1));
            if (sessionEntries.length > 0) {
              evt.preventDefault();
              const activeSessionId = snapshot.route.kind === "thread" ? snapshot.route.sessionId : null;
              const currentIdx = activeSessionId ? sessionEntries.findIndex((item) => item.sessionId === activeSessionId) : -1;
              const targetIdx = evt.key === "ArrowDown"
                ? Math.min(sessionEntries.length - 1, currentIdx + 1)
                : Math.max(0, currentIdx - 1);
              const destination = sessionEntries[targetIdx];
              if (destination) {
                ctrl.openThread(destination.sessionId);
              }
            }
          }
        }
      }
    };

    const handleMenuZoom = (e: Event): void => {
      const zoomStep = (e as CustomEvent<ZoomStep>).detail;
      if (zoomStep === "in" || zoomStep === "out" || zoomStep === "reset") {
        applyZoomStep(ctrl, zoomStep);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("ancilla-zoom-step", handleMenuZoom);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("ancilla-zoom-step", handleMenuZoom);
    };
  }, [ctrl]);

  return SYNC_HEADLESS_RESULT;
}

function WindowTitleSync(): null {
  const ctrl = useController();
  const attentionCount = useApp(windowTitleCount);
  const activeTitle = useApp((s) => (s.route.kind === "thread" ? (s.sessions[s.route.sessionId]?.title ?? null) : null));

  useEffect(function syncWindowDocumentTitle() {
    ctrl.setWindowTitle(windowTitle(attentionCount, activeTitle));
  }, [ctrl, attentionCount, activeTitle]);

  return SYNC_HEADLESS_RESULT;
}

function AwaySync(): null {
  const ctrl = useController();

  useEffect(function trackWindowBlurAndAway() {
    const handleVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        const curRoute = ctrl.store.get().route;
        if (curRoute.kind === "thread") {
          ctrl.markLeft(curRoute.sessionId);
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [ctrl]);

  return SYNC_HEADLESS_RESULT;
}

function PlanSync(): null {
  const ctrl = useController();
  useEffect(function runPeriodicPlanSync() {
    return startPlanSync(ctrl, document);
  }, [ctrl]);
  return SYNC_HEADLESS_RESULT;
}

function Shell(): ReactElement {
  const { boot, env, prefs, providers, skipMuseOnboarding, linuxSetup } = useApp((s) => ({
    boot: s.boot,
    env: s.env,
    prefs: s.prefs,
    providers: s.providers,
    skipMuseOnboarding: s.skipMuseOnboarding,
    linuxSetup: s.linuxSetup,
  }));

  const isCollapsed = prefs.sidebarCollapsed;
  const linuxInstallState = linuxSetup?.installation?.status;
  const hasAlternativeAI = Boolean(
    skipMuseOnboarding ||
      providers?.some(
        (p) => p.id !== "muse" && (p.id === "api" ? p.accounts.length > 0 : p.binary.available || p.accounts.length > 0),
      ),
  );

  let fullPageScreen: ReactElement | null = null;
  const isMissingEnv = env == null;

  if (isMissingEnv) {
    fullPageScreen = boot === "error" ? <BootError /> : <BootScreen />;
  } else if (
    (!env.museFound && !hasAlternativeAI) ||
    (env.platform === "linux" && (linuxInstallState === "installing" || linuxInstallState === "error" || linuxInstallState === "cancelled"))
  ) {
    fullPageScreen = <Onboarding />;
  } else if (boot === "error") {
    fullPageScreen = <BootError />;
  }

  if (fullPageScreen) {
    return (
      <React.Fragment key="ancilla-frameless-screen">
        {fullPageScreen}
        <FrameStrip key="ancilla-frameless-strip" />
      </React.Fragment>
    );
  }

  const sidebarDisclosure = cn(
    "grid h-full transition-[grid-template-columns,visibility] duration-200 ease-drawer motion-reduce:transition-none",
    isCollapsed ? "grid-cols-[0fr] invisible" : "grid-cols-[1fr] visible",
  );

  return (
    <div className="flex h-full w-full bg-bg text-fg" key="ancilla-main-shell">
      <div className={sidebarDisclosure}>
        <aside className="min-w-0 overflow-hidden select-none">
          <Sidebar key="ancilla-sidebar-panel" />
        </aside>
      </div>
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Main key="ancilla-main-view" />
      </main>
    </div>
  );
}

function Main(): ReactElement | null {
  const { route, sessionsLoaded, projects, prefs } = useApp((s) => ({
    route: s.route,
    sessionsLoaded: s.sessionsLoaded,
    projects: s.projects,
    prefs: s.prefs,
  }));

  if (!sessionsLoaded) return null;

  switch (route.kind) {
    case "usage":
      return <UsagePage key="page-usage" />;
    case "settings":
      return <SettingsPage key="page-settings" />;
    case "assistant":
      return <AssistantPage key="page-assistant" />;
    case "thread":
      return <ThreadView key={route.sessionId} sessionId={route.sessionId} />;
    case "new":
      return <NewThread cwd={route.cwd} key="page-new-thread" />;
    default:
      return projects.length > 0 ? (
        <NewThread cwd={prefs.lastProject} key="page-last-thread" />
      ) : (
        <Welcome key="page-welcome" />
      );
  }
}
