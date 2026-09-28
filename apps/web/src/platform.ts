import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { browserPlatform, type FileSaver, type Platform } from "@ancilla/ui";

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
  }
  return platform;
}
