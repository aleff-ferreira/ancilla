import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { writeFile } from "@tauri-apps/plugin-fs";
import { browserPlatform, type FileSaver, type LinuxDesktopStatus, type Platform } from "@ancilla/ui";

declare global {
  interface Window {
    /** Set by the Linux shell before page load; system packages must never use the AppImage updater. */
    __ANCILLA_LINUX_INSTALL__?: "appimage" | "package" | "development";
  }
}

/** Save As grants access to the chosen file only; no broad filesystem scope is needed. */
export const saveDesktopFile: FileSaver = async (options, contents) => {
  const path = await save({
    title: "Save research report",
    defaultPath: options.name,
    filters: [{ name: options.description, extensions: [options.extension] }],
  });
  if (path === null) {
    return null;
  }
  // Finish rendering/reading before opening the destination, preserving an existing file on export errors.
  const bytes = await contents();
  await writeFile(path, bytes);
  return { kind: "saved", path, name: path.split(/[\\/]/).at(-1) || options.name };
};

/** The shared browser environment with native Save As in the desktop webview. */
export function appPlatform(): Platform {
  const platform = browserPlatform();
  if ("__TAURI_INTERNALS__" in window) {
    platform.saveFile = saveDesktopFile;
    if (window.__ANCILLA_LINUX_INSTALL__) {
      platform.linuxDesktop = {
        status: () => invoke<LinuxDesktopStatus>("linux_installation_status"),
        install: ({ desktopShortcut }) => invoke<LinuxDesktopStatus>("install_linux_launcher", { desktopShortcut }),
        relaunch: () => invoke<void>("relaunch_installed_linux"),
      };
    }
  }
  return platform;
}
