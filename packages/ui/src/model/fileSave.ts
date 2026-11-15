/** A document's suggested name and the matching picker filter. */
export interface FileSaveOptions {
  name: string;
  extension: string;
  mimeType: string;
  description: string;
}

export interface FileSaveResult {
  name: string;
  /** Native shells can show the chosen location; browsers intentionally hide its full path. */
  path?: string;
  kind: "saved" | "download";
}

/** Pick first, then render/read the file. A cancelled picker returns null without calling `contents`. */
export type FileSaver = (options: FileSaveOptions, contents: () => Promise<Uint8Array>) => Promise<FileSaveResult | null>;

interface SavePickerOptions {
  id: string;
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}

type PickerWindow = Window & {
  showSaveFilePicker?: (options: SavePickerOptions) => Promise<FileSystemFileHandle>;
};

/**
 * Chromium exposes a native Save As picker in secure contexts. Call it before awaiting the document, while
 * the menu click still grants user activation. Other browsers use their own configured download behavior.
 */
export const saveBrowserFile: FileSaver = async (options, contents) => {
  const pickerWindow = window as PickerWindow;
  if (typeof pickerWindow.showSaveFilePicker === "function") {
    let file: FileSystemFileHandle;
    try {
      file = await pickerWindow.showSaveFilePicker({
        id: "ancilla-report",
        suggestedName: options.name,
        types: [{ description: options.description, accept: { [options.mimeType]: [`.${options.extension}`] } }],
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return null;
      }
      throw error;
    }
    // Read the whole response before opening a writer, so a failed export cannot truncate an existing file.
    const bytes = await contents();
    const writer = await file.createWritable();
    try {
      await writer.write(new Uint8Array(bytes));
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
    return { kind: "saved", name: file.name };
  }

  const bytes = await contents();
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: options.mimeType }));
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = options.name;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // The browser may consume the URL after click() returns. Keep it alive long enough for that handoff.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return { kind: "download", name: options.name };
};
