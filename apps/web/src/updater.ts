// Ancilla Desktop Auto-Updater Integration
// Bridges UI with Tauri native update manager plugin and window close events
import { getVersion as queryDesktopAppVersion } from "@tauri-apps/api/app";
import { getCurrentWindow as resolveCurrentTauriWindow } from "@tauri-apps/api/window";
import { relaunch as triggerAppRelaunch } from "@tauri-apps/plugin-process";
import { check as fetchRemoteUpdate, type Update as TauriReleaseRecord } from "@tauri-apps/plugin-updater";
import type { AppUpdater } from "@ancilla/ui";
// Timeouts to prevent update checks or downloads from hanging indefinitely
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
/**
 * Creates and returns the desktop updater adapter if running in Tauri desktop.
 * Returns undefined for web environments or Linux package installations (apt/rpm).
 */
export function desktopUpdater(): AppUpdater | undefined {
  // Verify running within Tauri native shell context
  const isTauriEnvironment = Boolean("__TAURI_INTERNALS__" in window);
  if (!isTauriEnvironment) {
    return undefined;
  }
  // Package-managed Linux distributions (e.g. deb, rpm) update via system package manager
  const linuxInstallType = (window as unknown as { __ANCILLA_LINUX_INSTALL__?: string }).__ANCILLA_LINUX_INSTALL__;
  if (linuxInstallType && linuxInstallType !== "appimage") {
    return undefined;
  }
  // Cache reference to active update
  let cachedUpdate: TauriReleaseRecord | null = null;
  // Construct updater adapter instance
  const updaterAdapter: AppUpdater = {
    currentVersion: () => queryDesktopAppVersion(),
    // Query available release
    async check(): Promise<{ version: string; notes: string | null; date: string | null } | null> {
      const release = await fetchRemoteUpdate({ timeout: UPDATE_CHECK_TIMEOUT_MS });
      if (cachedUpdate && cachedUpdate !== release) {
        cachedUpdate.close().catch(() => {});
      }
      cachedUpdate = release;
      if (!release) {
        return null;
      }
      return {
        version: release.version,
        notes: release.body?.trim() || null,
        date: release.date ?? null,
      };
    },
    // Initiate download with chunk progress monitoring
    async download(reportProgress) {
      if (!cachedUpdate) {
        throw new Error("Cannot download update: no release metadata is currently active.");
      }
      let expectedBytes: number | null = null;
      let transferredBytes = 0;
      // Stream binary chunks from remote update repository
      await cachedUpdate.download(
        (chunkEvent) => {
          if (chunkEvent.event === "Started") {
            expectedBytes = chunkEvent.data.contentLength ?? null;
            reportProgress(expectedBytes ? 0 : null);
          } else if (chunkEvent.event === "Progress") {
            transferredBytes += chunkEvent.data.chunkLength;
            const progressRatio = expectedBytes ? Math.min(1, transferredBytes / expectedBytes) : null;
            reportProgress(progressRatio);
          } else {
            reportProgress(1.0);
          }
        },
        { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS },
      );
    },
    // Apply downloaded release and optionally restart
    async install({ restart = false }: { restart?: boolean } = {}) {
      if (!cachedUpdate) {
        throw new Error("Cannot install update: no downloaded release is ready.");
      }
      await cachedUpdate.install({ restartAfterInstall: restart });
    },
    // Trigger host process restart
    relaunch: () => triggerAppRelaunch(),
    // Handle window close event subscription
    onClose(closeCallback) {
      const windowRef = resolveCurrentTauriWindow();
      const unlistenPromise = windowRef.onCloseRequested(async () => {
        await closeCallback();
      });
      return () => {
        unlistenPromise.then(
          (disposeFn) => { disposeFn(); },
          () => { /* ignore */ },
        );
      };
    },
  };
  // Return configured updater adapter
  return updaterAdapter;
}
